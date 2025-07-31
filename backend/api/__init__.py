from fastapi import APIRouter
from . import users
from . import templates
from . import messages
from . import tasks
from . import search_tasks
from . import proxy
from . import dashboard
from . import user_groups

__all__ = ['users', 'templates', 'messages', 'tasks', 'search_tasks', 'proxy', 'dashboard', 'user_groups']

router = APIRouter()

router.include_router(users.router, prefix="/users", tags=["users"])
router.include_router(templates.router, prefix="/templates", tags=["templates"])
router.include_router(messages.router, prefix="/messages", tags=["messages"])
router.include_router(tasks.router, prefix="/tasks", tags=["tasks"])
router.include_router(search_tasks.router, prefix="/search-tasks", tags=["search-tasks"])
router.include_router(proxy.router, prefix="/proxy", tags=["proxy"])
router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
router.include_router(user_groups.router, prefix="/user-groups", tags=["user-groups"])
