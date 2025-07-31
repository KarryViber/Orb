from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import logging
from typing import List, Optional

from models.database import get_db
from models.models import User, SearchTask, Message, Activity
from models.template import MessageTemplate
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(tags=["dashboard"])

class DashboardStats(BaseModel):
    """仪表盘统计数据响应模型"""
    totalUsers: int
    activeUsers: int
    totalMessages: int
    deliveredMessages: int
    totalTemplates: int
    activeTemplates: int
    totalTasks: int
    runningTasks: int

class ActivityResponse(BaseModel):
    """活动记录响应模型"""
    id: int
    time: datetime
    type: str
    content: str
    related_id: int | None
    related_type: str | None

    class Config:
        from_attributes = True

@router.get("/stats", response_model=DashboardStats)
async def get_dashboard_stats(db: Session = Depends(get_db)):
    """获取仪表盘统计数据"""
    try:
        # 计算活跃时间范围（最近7天）
        active_time = datetime.utcnow() - timedelta(days=7)
        
        # 获取用户统计
        total_users = db.query(User).count()
        active_users = db.query(User).filter(User.updated_at > active_time).count()
        
        # 获取任务统计
        total_tasks = db.query(SearchTask).count()
        running_tasks = db.query(SearchTask).filter(
            SearchTask.status == "running"
        ).count()
        
        # 获取模板统计
        total_templates = db.query(MessageTemplate).count()
        active_templates = db.query(MessageTemplate).filter(
            MessageTemplate.is_active == True
        ).count()
        
        # 获取消息统计
        total_messages = db.query(Message).count()
        delivered_messages = db.query(Message).filter(
            Message.status == "delivered"
        ).count()
        
        return DashboardStats(
            totalUsers=total_users,
            activeUsers=active_users,
            totalMessages=total_messages,
            deliveredMessages=delivered_messages,
            totalTemplates=total_templates,
            activeTemplates=active_templates,
            totalTasks=total_tasks,
            runningTasks=running_tasks
        )
    except Exception as e:
        logger.error(f"获取仪表盘统计数据失败: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"获取仪表盘统计数据失败: {str(e)}"
        )

@router.get("/activities", response_model=List[ActivityResponse])
async def get_recent_activities(
    limit: int = 10,
    db: Session = Depends(get_db)
):
    """获取最近活动记录"""
    try:
        activities = db.query(Activity)\
            .order_by(Activity.time.desc())\
            .limit(limit)\
            .all()
        return activities
    except Exception as e:
        logger.error(f"获取最近活动记录失败: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"获取最近活动记录失败: {str(e)}"
        )
