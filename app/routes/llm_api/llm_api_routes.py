"""OpenAI-compatible LLM API.

- Public (API token required): GET /llm/v1/models · POST /llm/v1/chat/completions (including streaming).
  The dashboard login cookie is not looked at — only Authorization: Bearer <token>. Everything is 404 while the server is off.
  (No cookie is used, so only /llm/v1/ is exempt from the Origin check in SecurityMiddleware.)
- Admin (dashboard login required): /api/llm/* — on/off · accounts · tokens · settings · log · test call.
"""

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.i18n import _
from app.security import LoginRateLimiter, client_key
from app.services.core.auth_service import AuthService
from app.services.llm_api import llm_api_service as llm
from app.services.llm_api import llm_sandbox
from app.services.llm_api.llm_api_service import ApiError

router = APIRouter()
api_auth = [Depends(AuthService.require_user)]
logger = logging.getLogger(__name__)

MAX_BODY = 8 * 1024 * 1024
HEARTBEAT = 15.0
QUICK_WAIT = (
    20.0  # non-streaming requests: a plain JSON response if it finishes within this
)
_bad_keys = LoginRateLimiter(
    max_attempts=10,
    window_seconds=300,
    lockout_seconds=600,
    global_max_attempts=200,
    global_window_seconds=300,
    global_lockout_seconds=300,
)
JSON_INSTRUCTION = "\n\nRespond with a single valid JSON value only. No prose, no markdown fences, no explanations."
_SSE_HEADERS = {"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"}


def _error(error: ApiError, **headers) -> JSONResponse:
    return JSONResponse(
        status_code=error.status,
        content={
            "error": {
                "message": error.message,
                "type": error.kind,
                "param": None,
                "code": error.code,
            }
        },
        headers={"Cache-Control": "no-store", **headers},
    )


def _gate(request: Request) -> tuple[dict | None, JSONResponse | None]:
    """(token record, error response). While off, a 404 as if nothing existed."""
    if not llm.enabled():
        return None, _error(
            ApiError(404, "Not found.", "invalid_request_error", "not_found")
        )
    who = client_key(request)
    wait = _bad_keys.retry_after(who)
    if wait:
        return None, _error(
            ApiError(
                429, "Too many invalid API keys. Try again later.", "rate_limit_error"
            ),
            **{"Retry-After": str(wait)},
        )
    auth = request.headers.get("authorization") or ""
    token = (
        auth[7:].strip()
        if auth[:7].lower() == "bearer "
        else (request.headers.get("x-api-key") or "")
    )
    record = llm.authenticate(token)
    if record is None:
        _bad_keys.record_failure(who)
        logger.warning("LLM API: invalid token · client=%s", who)
        return None, _error(
            ApiError(
                401,
                "Incorrect API key provided.",
                "invalid_request_error",
                "invalid_api_key",
            ),
            **{"WWW-Authenticate": "Bearer"},
        )
    return record, None


# ── Messages → prompt ─────────────────────────────────────────────────────────
def _content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                if part.get("type") in (None, "text", "input_text", "output_text"):
                    parts.append(str(part.get("text") or ""))
                elif part.get("type") in ("image_url", "input_image", "image"):
                    parts.append("[image omitted: this endpoint accepts text only]")
        return "\n".join(p for p in parts if p)
    return str(content)


_ROLE = {"user": "User", "assistant": "Assistant", "tool": "Tool", "function": "Tool"}


def _prompt(messages: Any) -> tuple[str, str]:
    """OpenAI messages → (system instructions, prompt). With several turns the conversation is written out as text and the model answers the last message."""
    if not isinstance(messages, list) or not messages:
        raise ApiError(
            400, "'messages' must be a non-empty array.", "invalid_request_error"
        )
    system, turns = [], []
    for message in messages[:2000]:
        if not isinstance(message, dict):
            raise ApiError(
                400, "Each message must be an object.", "invalid_request_error"
            )
        role = str(message.get("role") or "user")
        text = _content_text(message.get("content")).strip()
        if not text:
            continue
        if role in ("system", "developer"):
            system.append(text)
        else:
            turns.append((role, text))
    if not turns:
        raise ApiError(
            400,
            "'messages' must contain at least one non-empty message.",
            "invalid_request_error",
        )
    if len(turns) == 1 and turns[0][0] == "user":
        return "\n\n".join(system), turns[0][1]
    lines = ["[Conversation so far]"]
    for role, text in turns[:-1]:
        lines.append(f"{_ROLE.get(role, role.title())}: {text}")
    role, text = turns[-1]
    lines += [
        "",
        f"[Latest {_ROLE.get(role, role).lower()} message — reply to this]",
        text,
    ]
    return "\n\n".join(system), "\n".join(lines)


_FENCE = re.compile(r"^\s*```[A-Za-z0-9_-]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


def _json_text(text: str) -> str:
    """JSON mode: strips code fences · surrounding chatter and keeps only valid JSON (as received if that fails)."""
    body = text.strip()
    fenced = _FENCE.match(body)
    if fenced:
        body = fenced.group(1).strip()
    candidates = [body]
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = body.find(opener), body.rfind(closer)
        if 0 <= start < end:
            candidates.append(body[start : end + 1])
    for candidate in candidates:
        try:
            return json.dumps(json.loads(candidate), ensure_ascii=False)
        except ValueError:
            continue
    return text.strip()


def _estimate(text: str) -> int:
    return max(1, len(text) // 4) if text else 0


# ── Public API ────────────────────────────────────────────────────────────────
@router.get("/llm/v1/models")
async def list_models(request: Request):
    record, denied = await asyncio.to_thread(_gate, request)
    if denied:
        return denied
    now = int(time.time())
    allowed = set(record.get("providers") or [])
    data = [
        {"id": m["id"], "object": "model", "created": now, "owned_by": m["owned_by"]}
        for m in await asyncio.to_thread(llm.models)
        if m["owned_by"] == "alias" or m["id"].split("/")[0] in allowed
    ]
    return JSONResponse(
        {"object": "list", "data": data}, headers={"Cache-Control": "no-store"}
    )


@router.get("/llm/v1/models/{model:path}")
async def get_model(request: Request, model: str):
    _record, denied = await asyncio.to_thread(_gate, request)
    if denied:
        return denied
    for item in await asyncio.to_thread(llm.models):
        if item["id"] == model:
            return {
                "id": model,
                "object": "model",
                "created": int(time.time()),
                "owned_by": item["owned_by"],
            }
    return _error(
        ApiError(
            404,
            f"The model '{model[:80]}' does not exist.",
            "invalid_request_error",
            "model_not_found",
        )
    )


async def _read_json(request: Request) -> dict:
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY:
            raise ApiError(413, "Request body is too large.", "invalid_request_error")
    try:
        data = json.loads(body)
    except ValueError:
        raise ApiError(
            400, "Request body must be valid JSON.", "invalid_request_error"
        ) from None
    if not isinstance(data, dict):
        raise ApiError(
            400, "Request body must be a JSON object.", "invalid_request_error"
        )
    return data


class _Run:
    """The execution of one request: answer chunks arrive on a queue used by both streaming · plain responses. Logged when done."""

    def __init__(
        self,
        record: dict | None,
        model: str | None,
        system: str,
        prompt: str,
        json_mode: bool,
        stream: bool,
        ip: str,
    ):
        self.record = record
        self.requested = model
        self.system, self.prompt = system, prompt
        self.json_mode, self.stream, self.ip = json_mode, stream, ip
        self.meta: dict = {}
        self.queue: asyncio.Queue = asyncio.Queue()
        self.text: list[str] = []
        self.usage: dict | None = None
        self.error: ApiError | None = None
        self.started = time.monotonic()
        # For the log: the received messages (role · text). Unless set otherwise: system instructions + prompt
        self.messages: list[dict] = (
            [{"role": "system", "text": system}] if system else []
        ) + [{"role": "user", "text": prompt}]
        self.task = asyncio.create_task(self._pump())

    async def _pump(self) -> None:
        generator = llm.generate(
            self.requested, self.system, self.prompt, self.record, self.meta
        )
        try:
            async for kind, value in generator:
                if kind == "text":
                    self.text.append(value)
                    await self.queue.put(("text", value))
                elif kind == "usage":
                    self.usage = value
        except ApiError as error:
            self.error = error
        except asyncio.CancelledError:
            self.error = ApiError(
                499, "Client closed the request.", "api_error", "client_closed"
            )
            raise
        except Exception:
            logger.exception("LLM API request failed")
            self.error = ApiError(500, "Internal server error.", "api_error")
        finally:
            await generator.aclose()
            self._record()
            self.queue.put_nowait(("end", None))

    def _record(self) -> None:
        output = "".join(self.text)
        usage = self.usage or {
            "input": _estimate(self.system + self.prompt),
            "output": _estimate(output),
        }
        entry = {
            "model": self.meta.get("model") or (self.requested or "")[:80],
            "provider": self.meta.get("provider"),
            "account": self.meta.get("account"),
            "status": self.error.status if self.error else 200,
            "error": self.error.code or self.error.kind if self.error else None,
            "stream": self.stream,
            "ms": int((time.monotonic() - self.started) * 1000),
            "input_tokens": usage["input"],
            "output_tokens": usage["output"],
            "ip": self.ip,
        }
        try:
            content = {
                "messages": self.messages,
                "answer": self.final_text() if output else "",
                "error": self.error.message if self.error else "",
            }
            llm.record_request(self.record, entry, content)
        except Exception:
            logger.exception("LLM API logging failed")

    def usage_body(self) -> dict:
        output = "".join(self.text)
        usage = self.usage or {
            "input": _estimate(self.system + self.prompt),
            "output": _estimate(output),
        }
        return {
            "prompt_tokens": usage["input"],
            "completion_tokens": usage["output"],
            "total_tokens": usage["input"] + usage["output"],
        }

    def final_text(self) -> str:
        text = "".join(self.text).strip()
        return _json_text(text) if self.json_mode else text

    def cancel(self) -> None:
        if not self.task.done():
            self.task.cancel()


@router.post("/llm/v1/chat/completions")
async def chat_completions(request: Request):
    record, denied = await asyncio.to_thread(_gate, request)
    if denied:
        return denied
    try:
        wait = llm.check_rate(record)
        if wait:
            return _error(
                ApiError(
                    429,
                    "Rate limit reached for this API key.",
                    "rate_limit_error",
                    "rate_limit_exceeded",
                ),
                **{"Retry-After": str(wait)},
            )
        body = await _read_json(request)
        system, prompt = _prompt(body.get("messages"))
        model = body.get("model")
        if model is not None and not isinstance(model, str):
            raise ApiError(400, "'model' must be a string.", "invalid_request_error")
        if isinstance(body.get("n"), int) and body["n"] > 1:
            raise ApiError(400, "Only n=1 is supported.", "invalid_request_error")
        fmt = (
            body.get("response_format")
            if isinstance(body.get("response_format"), dict)
            else {}
        )
        json_mode = fmt.get("type") in ("json_object", "json_schema")
        if json_mode:
            schema = (
                (fmt.get("json_schema") or {}).get("schema")
                if isinstance(fmt.get("json_schema"), dict)
                else None
            )
            prompt += JSON_INSTRUCTION
            if schema:
                prompt += (
                    "\nThe JSON must conform to this JSON Schema:\n"
                    + json.dumps(schema, ensure_ascii=False)[:20000]
                )
        stream = body.get("stream") is True
        include_usage = (
            isinstance(body.get("stream_options"), dict)
            and body["stream_options"].get("include_usage") is True
        )
        # Model · permission errors are reported right away, before running
        await asyncio.to_thread(llm.resolve, model, record)
    except ApiError as error:
        return _error(error)

    run = _Run(record, model, system, prompt, json_mode, stream, client_key(request))
    run.messages = [
        {"role": str(m.get("role") or "user"), "text": _content_text(m.get("content"))}
        for m in body["messages"][:2000]
        if isinstance(m, dict)
    ]
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    model_name = model or await asyncio.to_thread(llm.default_model)

    if not stream:
        return await _plain_response(run, completion_id, created, model_name)

    # The response starts after waiting for the first chunk (or an error) → an error right at the start becomes a proper HTTP error
    try:
        first = await run.queue.get()
    except asyncio.CancelledError:
        run.cancel()
        raise
    if first[0] == "end" and run.error:
        return _error(run.error)

    def chunk(delta: dict, finish: str | None = None, usage: dict | None = None) -> str:
        payload = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        if include_usage:
            payload["usage"] = None
        if usage is not None:
            payload["choices"], payload["usage"] = [], usage
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    async def sse():
        try:
            yield chunk({"role": "assistant", "content": ""})
            item = first
            while True:
                if item is None:
                    try:
                        item = await asyncio.wait_for(
                            run.queue.get(), timeout=HEARTBEAT
                        )
                    except TimeoutError:
                        # so the proxy (nginx) does not drop a quiet connection
                        yield ": keep-alive\n\n"
                        continue
                kind, value = item
                item = None
                if kind == "end":
                    break
                if not json_mode:  # JSON mode collects everything and sends it at once
                    yield chunk({"content": value})
            if run.error:
                error = run.error
                yield f"data: {json.dumps({'error': {'message': error.message, 'type': error.kind, 'code': error.code}})}\n\n"
            else:
                if json_mode:
                    yield chunk({"content": run.final_text()})
                yield chunk({}, "stop")
                if include_usage:
                    yield chunk({}, usage=run.usage_body())
            yield "data: [DONE]\n\n"
        finally:
            run.cancel()  # if the receiver disconnected, the CLI stops too

    return StreamingResponse(
        sse(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


def _completion(run: _Run, completion_id: str, created: int, model_name: str) -> dict:
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": run.final_text(),
                    "refusal": None,
                },
                "logprobs": None,
                "finish_reason": "stop",
            }
        ],
        "usage": run.usage_body(),
    }


async def _plain_response(run: _Run, completion_id: str, created: int, model_name: str):
    try:
        await asyncio.wait_for(asyncio.shield(run.task), timeout=QUICK_WAIT)
    except TimeoutError:
        pass
    except asyncio.CancelledError:
        run.cancel()
        raise
    if run.task.done():
        if run.error:
            return _error(run.error)
        return JSONResponse(
            _completion(run, completion_id, created, model_name),
            headers={"Cache-Control": "no-store"},
        )

    # Slow answers: the proxy drops a quiet connection after about 60 seconds, so spaces are sent little by little until
    # it finishes and the JSON is sent last (whitespace before JSON is valid syntax). The status code is already 200
    # by then, so errors are also reported through the error object in the body.
    async def body():
        try:
            while not run.task.done():
                yield " "
                await asyncio.wait({run.task}, timeout=HEARTBEAT)
            if run.error:
                error = run.error
                yield json.dumps(
                    {
                        "error": {
                            "message": error.message,
                            "type": error.kind,
                            "param": None,
                            "code": error.code,
                        }
                    }
                )
            else:
                yield json.dumps(
                    _completion(run, completion_id, created, model_name),
                    ensure_ascii=False,
                )
        finally:
            run.cancel()

    return StreamingResponse(
        body(), media_type="application/json", headers=_SSE_HEADERS
    )


async def sync_sandbox() -> None:
    """Keeps the sandbox container running while the API server is on, and removes it while off."""
    try:
        if await asyncio.to_thread(llm.enabled):
            if not await asyncio.to_thread(llm_sandbox.problem):
                await llm_sandbox.ensure_container()
        else:
            await llm_sandbox.stop_container()
    except Exception:
        logger.exception("Could not sync the LLM sandbox container state")


# ── Admin ─────────────────────────────────────────────────────────────────────
def _bad(error: Exception):
    if isinstance(error, KeyError):
        raise HTTPException(status_code=404, detail=_("없는 항목입니다.")) from error
    if isinstance(error, ApiError):
        raise HTTPException(
            status_code=400,
            detail=_(
                "모델 이름이 올바르지 않습니다 (예: claude, claude/sonnet, codex)."
            ),
        ) from error
    raise HTTPException(
        status_code=400, detail=str(error) or _("잘못된 요청입니다.")
    ) from error


@router.get("/api/llm/state", dependencies=api_auth)
async def llm_state():
    return await asyncio.to_thread(llm.state)


class SettingsBody(BaseModel):
    enabled: bool | None = None
    providers: dict[str, bool] | None = None
    strategy: str | None = Field(default=None, max_length=20)
    default_model: str | None = Field(default=None, max_length=80)
    aliases: dict[str, str] | None = None
    max_concurrency: int | None = Field(default=None, ge=1, le=8)
    timeout: int | None = Field(default=None, ge=10, le=1800)
    fast: bool | None = None
    keep_content: bool | None = None
    content_days: int | None = Field(default=None, ge=1, le=365)


@router.put("/api/llm/settings", dependencies=api_auth)
async def llm_settings(body: SettingsBody):
    try:
        await asyncio.to_thread(llm.update_settings, body.model_dump(exclude_none=True))
    except (ValueError, ApiError) as error:
        _bad(error)
    if body.enabled is not None:
        await sync_sandbox()
    return await asyncio.to_thread(llm.state)


class AccountBody(BaseModel):
    provider: str = Field(max_length=10)
    id: str = Field(max_length=12)
    enabled: bool


@router.put("/api/llm/accounts", dependencies=api_auth)
async def llm_account(body: AccountBody):
    try:
        await asyncio.to_thread(llm.set_account, body.provider, body.id, body.enabled)
    except ValueError as error:
        _bad(error)
    return await asyncio.to_thread(llm.state)


class TokenBody(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    enabled: bool | None = None
    providers: list[str] | None = Field(default=None, max_length=4)
    rpm: int | None = Field(default=None, ge=0, le=600)
    expires_days: int | None = Field(default=None, ge=0, le=3650)
    accounts: dict[str, str] | None = None


@router.post("/api/llm/tokens", dependencies=api_auth)
async def llm_create_token(body: TokenBody):
    try:
        token, public = await asyncio.to_thread(
            llm.create_token, body.model_dump(exclude_none=True)
        )
    except ValueError as error:
        _bad(error)
    return {"token": token, "info": public}


@router.patch("/api/llm/tokens/{token_id}", dependencies=api_auth)
async def llm_update_token(token_id: str, body: TokenBody):
    try:
        return await asyncio.to_thread(
            llm.update_token, token_id[:32], body.model_dump(exclude_none=True)
        )
    except (KeyError, ValueError) as error:
        _bad(error)


@router.post("/api/llm/tokens/{token_id}/rotate", dependencies=api_auth)
async def llm_rotate_token(token_id: str):
    try:
        token, public = await asyncio.to_thread(llm.rotate_token, token_id[:32])
    except KeyError as error:
        _bad(error)
    return {"token": token, "info": public}


@router.delete("/api/llm/tokens/{token_id}", dependencies=api_auth)
async def llm_delete_token(token_id: str):
    try:
        await asyncio.to_thread(llm.delete_token, token_id[:32])
    except KeyError as error:
        _bad(error)
    return {"ok": True}


@router.get("/api/llm/log/{request_id}", dependencies=api_auth)
async def llm_log_item(request_id: str):
    """The received messages · sent answer of one request (admin only)."""
    data = await asyncio.to_thread(llm.request_content, request_id[:16])
    if data is None:
        raise HTTPException(status_code=404, detail=_("기록을 찾을 수 없습니다."))
    return data


@router.delete("/api/llm/log", dependencies=api_auth)
async def llm_clear_log():
    await asyncio.to_thread(llm.clear_log)
    return {"ok": True}


class TestBody(BaseModel):
    model: str = Field(default="", max_length=80)
    prompt: str = Field(min_length=1, max_length=20000)
    system: str = Field(default="", max_length=20000)


@router.post("/api/llm/test", dependencies=api_auth)
async def llm_test(body: TestBody, request: Request):
    """The test call from the admin screen: runs once through the same path without a token (even while the server is off)."""
    run = _Run(
        None,
        body.model or None,
        body.system,
        body.prompt,
        False,
        False,
        client_key(request),
    )
    try:
        await run.task
    except asyncio.CancelledError:
        run.cancel()
        raise
    if not await asyncio.to_thread(llm.enabled):
        # Only a test while turned off: do not leave the container behind
        await llm_sandbox.stop_container()
    if run.error:
        raise HTTPException(
            status_code=502,
            detail=f"{run.error.message} ({run.error.code or run.error.kind})",
        )
    return {
        "text": run.final_text(),
        "model": run.meta.get("model"),
        "account": run.meta.get("account"),
        "ms": int((time.monotonic() - run.started) * 1000),
        "usage": run.usage_body(),
    }
