from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from sqlalchemy import func, or_
from typing import Optional, List
from models.database import get_db
from models.models import User, MessageTemplate, MessageTask, Message, TaskStatus
from .search_tasks import router as search_tasks_router
from .templates import router as templates_router
from .users import router as users_router
from .user_groups import router as user_groups_router
from .messages import router as messages_router
from .proxy import router as proxy_router

router = APIRouter()

# 注册搜索任务路由
router.include_router(search_tasks_router, prefix="/search-tasks")

# 注册模板路由
router.include_router(templates_router, prefix="/templates")

# 注册用户路由
router.include_router(users_router, prefix="/users")

# 注册用户组路由
router.include_router(user_groups_router, prefix="/user-groups")

# 注册消息任务路由
router.include_router(messages_router, prefix="/messages")

# 注册代理路由
router.include_router(proxy_router)

@router.get("/stats")
async def get_stats(db: Session = Depends(get_db)):
    """获取系统统计数据"""
    try:
        # 获取用户总数
        user_count = db.query(func.count(User.id)).scalar()

        # 获取模板总数
        template_count = db.query(func.count(MessageTemplate.id)).scalar()

        # 获取运行中的任务数
        running_tasks = db.query(func.count(MessageTask.id)).filter(
            MessageTask.status == TaskStatus.RUNNING
        ).scalar()

        # 获取今日发送的消息数
        today = datetime.utcnow().date()
        today_messages = db.query(func.count(Message.id)).filter(
            func.date(Message.created_at) == today
        ).scalar()

        return {
            "data": {
                "userCount": user_count,
                "templateCount": template_count,
                "runningTasks": running_tasks,
                "todayMessages": today_messages
            }
        }
    except Exception as e:
        return {
            "error": f"获取统计数据失败: {str(e)}"
        }

@router.get("/templates")
async def get_templates(db: Session = Depends(get_db)):
    """获取模板列表"""
    try:
        templates = db.query(MessageTemplate).order_by(MessageTemplate.created_at.desc()).all()
        return {
            "data": [
                {
                    "id": template.id,
                    "name": template.name,
                    "content": template.content,
                    "variables": template.variables or [],
                    "platform": template.platform.value,
                    "is_default": template.is_default,
                    "is_active": template.is_active,
                    "created_by": template.created_by,
                    "created_at": template.created_at.isoformat(),
                    "updated_at": template.updated_at.isoformat()
                }
                for template in templates
            ]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取模板列表失败: {str(e)}") 