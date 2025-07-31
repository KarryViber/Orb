from typing import List, Optional
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.background import BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from backend.services.instagram_search_service import InstagramSearchService
from backend.models.search_task import SearchTask
from backend.database.database import get_db
from backend.models.platform import Platform
from backend.models.search_task_response import SearchTaskResponse

router = APIRouter()

class SearchTaskCreate(BaseModel):
    """创建搜索任务的请求模型"""
    name: str
    platform: Platform
    keywords: List[str]
    min_followers: Optional[int] = None
    max_followers: Optional[int] = None
    location: Optional[str] = None
    is_verified: Optional[bool] = None
    is_private: Optional[bool] = None
    results_limit: Optional[int] = 1000  # 每个hashtag获取的帖子数量限制

@router.post("/search-tasks", response_model=SearchTaskResponse)
async def create_search_task(
    task: SearchTaskCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    api_token: str = Header(None, alias="X-API-Token")
):
    """创建新的搜索任务"""
    try:
        # 创建搜索任务记录
        search_params = {
            "keywords": task.keywords,
            "min_followers": task.min_followers,
            "max_followers": task.max_followers,
            "location": task.location,
            "is_verified": task.is_verified,
            "is_private": task.is_private,
            "results_limit": task.results_limit
        }
        
        db_task = SearchTask(
            name=task.name,
            platform=task.platform,
            search_params=search_params,
            status="pending",
            results_limit=task.results_limit or 1000
        )
        
        db.add(db_task)
        db.commit()
        db.refresh(db_task)
        
        # 在后台执行搜索任务
        background_tasks.add_task(
            InstagramSearchService.execute_search,
            task_id=db_task.id,
            keywords=task.keywords,
            min_followers=task.min_followers,
            max_followers=task.max_followers,
            location=task.location,
            is_verified=task.is_verified,
            is_private=task.is_private,
            results_limit=task.results_limit,
            api_token=api_token
        )
        
        return db_task
        
    except Exception as e:
        logger.error(f"创建搜索任务时出错: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) 