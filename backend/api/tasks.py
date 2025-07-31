from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from typing import List
from datetime import datetime

from models.database import get_db
from models.models import SearchTask, Platform
from schemas.tasks import SearchTaskCreate, SearchTaskResponse, SearchTaskUpdate
from services.instagram import InstagramSearchService

router = APIRouter(prefix="/tasks", tags=["tasks"])

@router.post("/search", response_model=SearchTaskResponse)
async def create_search_task(
    task: SearchTaskCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """创建搜索任务"""
    # 创建任务记录
    db_task = SearchTask(
        platform=task.platform,
        search_params={
            "keywords": task.keywords,
            "filters": task.filters
        },
        status="pending",
        result_count=0,
        is_completed=False
    )
    db.add(db_task)
    db.commit()
    db.refresh(db_task)

    # 添加后台任务
    if task.platform == Platform.INSTAGRAM:
        background_tasks.add_task(
            InstagramSearchService.execute_search,
            db_task.id,
            task.keywords,
            task.filters
        )

    return db_task

@router.get("/search", response_model=List[SearchTaskResponse])
async def get_search_tasks(
    platform: Platform = None,
    skip: int = 0,
    limit: int = 10,
    db: Session = Depends(get_db)
):
    """获取搜索任务列表"""
    query = db.query(SearchTask)
    if platform:
        query = query.filter(SearchTask.platform == platform)
    
    tasks = query.order_by(SearchTask.created_at.desc()).offset(skip).limit(limit).all()
    return tasks

@router.get("/search/{task_id}", response_model=SearchTaskResponse)
async def get_search_task(task_id: int, db: Session = Depends(get_db)):
    """获取搜索任务详情"""
    task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task

@router.put("/search/{task_id}", response_model=SearchTaskResponse)
async def update_search_task(
    task_id: int,
    task_update: SearchTaskUpdate,
    db: Session = Depends(get_db)
):
    """更新搜索任务状态"""
    db_task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
    if not db_task:
        raise HTTPException(status_code=404, detail="任务不存在")
    
    # 更新任务信息
    for key, value in task_update.dict(exclude_unset=True).items():
        setattr(db_task, key, value)
    
    if task_update.is_completed:
        db_task.completed_at = datetime.utcnow()
    
    db.commit()
    db.refresh(db_task)
    return db_task

@router.delete("/search/{task_id}")
async def delete_search_task(task_id: int, db: Session = Depends(get_db)):
    """删除搜索任务"""
    db_task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
    if not db_task:
        raise HTTPException(status_code=404, detail="任务不存在")
    
    db.delete(db_task)
    db.commit()
    return {"message": "任务已删除"} 