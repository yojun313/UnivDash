"""공통 페이지 렌더링: 로그인 확인 후 레이아웃(_layout.html)을 쓰는 페이지 템플릿을 그린다."""

from fastapi import Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from app.services.auth_service import AuthService

templates = Jinja2Templates(directory="app/templates")

# active_page → (템플릿, 제목, 설명)
PAGES = {
    "workspace": ("workspace.html", "Workspace", "tmux 창을 골라 Claude Code · Codex 에 바로 프롬프트를 보냅니다."),
    "organize": ("organize.html", "창 정리", "폴더, 순서, 숨김, 표시 이름을 정리합니다. 드래그하거나 ⋯ 메뉴를 쓰세요."),
    "server": ("server.html", "Server & Processes", "서버 자원과 PM2 프로세스를 한 페이지에서 실시간으로 관리합니다."),
    "ai_usage": ("ai_usage.html", "AI Usage", "Claude Code와 Codex의 남은 사용량(현재 세션 · 주간)과 토큰 사용 통계를 확인합니다."),
    "git": ("git.html", "Git Manager", "저장소를 폴더로 정리하고, 변경사항 스테이징부터 커밋 · 브랜치 · 병합 · 푸시까지 관리합니다."),
}


def render_page(request: Request, active_page: str, **context):
    user = AuthService.current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    template, title, description = PAGES[active_page]
    return templates.TemplateResponse(
        request=request,
        name=template,
        context={
            "username": user,
            "active_page": active_page,
            "page_title": title,
            "page_description": description,
            **context,
        },
    )
