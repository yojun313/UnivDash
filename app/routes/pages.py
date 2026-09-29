"""공통 페이지 렌더링: 로그인 확인 후 레이아웃(_layout.html)을 쓰는 페이지 템플릿을 그린다."""

from fastapi import Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates

from app.assets import install as install_assets
from app.services.auth_service import AuthService
from app.services.preferences import NAV_ORDER_DEFAULT, PreferencesStore

templates = Jinja2Templates(directory="app/templates")
install_assets(templates)

# active_page → (템플릿, 제목)
PAGES = {
    "workspace": ("workspace.html", "Workspace"),
    "explorer": ("explorer.html", "Explorer"),
    "server": ("server.html", "Servers"),
    "ai_usage": ("ai_usage.html", "AI Usage"),
    "git": ("git.html", "Git"),
}
NAV_ITEMS = (
    ("workspace", "/", "fa-terminal", "Workspace"),
    ("explorer", "/explorer", "fa-folder-tree", "Explorer"),
    ("git", "/git", "fa-code-branch", "Git"),
    ("ai_usage", "/ai-usage", "fa-robot", "AI Usage"),
    ("server", "/server", "fa-server", "Servers"),
)


def render_page(request: Request, active_page: str, **context):
    user = AuthService.current_user(request)
    if not user:
        return RedirectResponse(url="/login", status_code=303)
    template, title = PAGES[active_page]
    saved_order = PreferencesStore.load().nav_order or NAV_ORDER_DEFAULT
    order = {key: index for index, key in enumerate(saved_order)}
    return templates.TemplateResponse(
        request=request,
        name=template,
        context={
            "username": user,
            "active_page": active_page,
            "page_title": title,
            "nav_items": sorted(
                NAV_ITEMS, key=lambda item: order.get(item[0], len(order))
            ),
            **context,
        },
    )
