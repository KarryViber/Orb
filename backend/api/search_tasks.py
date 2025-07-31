from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request
from sqlalchemy.orm import Session
from sqlalchemy import or_, cast, String
from typing import List, Optional
from datetime import datetime, timedelta
import logging
import os

from models.database import get_db
from models.models import SearchTask, Platform, User, Message, Activity, search_task_users
from models.template import MessageTemplate as Template
from schemas.search_tasks import (
    SearchParams, SearchTaskCreate, SearchTaskResponse, 
    SearchTaskUpdate, SearchTaskListResponse, DashboardStats, 
    ActivityResponse
)
from services.instagram import InstagramSearchService
from services.twitter import TwitterSearchService

logger = logging.getLogger(__name__)
router = APIRouter(tags=["search-tasks"])

@router.post("", response_model=SearchTaskResponse)
async def create_search_task(
    task: SearchTaskCreate,
    background_tasks: BackgroundTasks,
    request: Request,
    db: Session = Depends(get_db)
):
    """创建搜索任务"""
    try:
        # 从请求头获取 API Token
        api_token = request.headers.get('X-Apify-Token')
        logger.info(f"从请求头获取到 API Token: {api_token[:5] if api_token else 'None'}...")
        logger.info(f"环境变量中的 API Token: {os.getenv('APIFY_API_TOKEN', '')[:5]}...")
        
        # 创建任务记录
        db_task = SearchTask(
            name=task.name,
            platform=task.platform,
            search_params=task.search_params.model_dump(),
            status="pending",
            result_count=0,
            results_limit=task.results_limit or 1000,
            is_completed=False,
            created_at=datetime.utcnow()
        )
        db.add(db_task)
        db.commit()
        db.refresh(db_task)

        # 添加后台任务
        if task.platform == Platform.INSTAGRAM:
            background_tasks.add_task(
                InstagramSearchService.execute_search,
                db_task.id,
                task.search_params.keywords,
                min_followers=task.search_params.min_followers,
                max_followers=task.search_params.max_followers,
                location=task.search_params.location[0] if task.search_params.location else None,
                is_verified=task.search_params.is_verified,
                is_private=task.search_params.is_private,
                results_limit=task.results_limit,
                api_token=api_token
            )
        elif task.platform == Platform.TWITTER:
            background_tasks.add_task(
                TwitterSearchService.execute_search,
                db_task.id,
                task.search_params.keywords,
                min_followers=task.search_params.min_followers,
                max_followers=task.search_params.max_followers,
                location=task.search_params.location[0] if task.search_params.location else None,
                is_verified=task.search_params.is_verified,
                language=task.search_params.language,
                results_limit=task.results_limit,
                api_token=api_token
            )

        # 构造响应数据
        return SearchTaskResponse.model_validate(db_task)

    except Exception as e:
        logger.error(f"创建搜索任务失败: {str(e)}")
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"创建搜索任务失败: {str(e)}"
        )

@router.get("", response_model=SearchTaskListResponse)
async def get_search_tasks(
    platform: Optional[Platform] = None,
    keyword: Optional[str] = None,
    page: int = 1,
    pageSize: int = 10,
    db: Session = Depends(get_db)
):
    """获取搜索任务列表"""
    try:
        logger.info(f"开始获取搜索任务列表 - platform: {platform}, keyword: {keyword}, page: {page}, pageSize: {pageSize}")
        
        query = db.query(SearchTask)
        
        # 平台筛选
        if platform:
            try:
                # 直接使用 Platform 枚举
                if isinstance(platform, Platform):
                    platform_enum = platform
                else:
                    # 尝试将字符串转换为 Platform 枚举
                    platform_str = str(platform).lower()
                    platform_enum = Platform(platform_str)
                
                if platform_enum:
                    query = query.filter(SearchTask.platform == platform_enum)
                    logger.info(f"应用平台筛选: {platform_enum}")
                else:
                    raise ValueError(f"无效的平台值: {platform}")
            except ValueError as e:
                logger.error(f"无效的平台值: {platform}")
                raise HTTPException(status_code=400, detail=f"无效的平台值: {platform}，支持的平台有：{[p.value for p in Platform]}")
        
        # 关键词搜索
        if keyword:
            query = query.filter(SearchTask.name.ilike(f"%{keyword}%"))
            logger.info(f"应用关键词筛选: {keyword}")
        
        # 获取总数
        try:
            total = query.count()
            logger.info(f"符合条件的任务总数: {total}")
        except Exception as e:
            logger.error(f"获取任务总数失败: {str(e)}")
            raise HTTPException(status_code=500, detail=f"获取任务总数失败: {str(e)}")
        
        # 分页并按创建时间倒序排序
        try:
            tasks = query.order_by(SearchTask.created_at.desc())\
                .offset((page - 1) * pageSize)\
                .limit(pageSize)\
                .all()
            logger.info(f"当前页获取到 {len(tasks)} 个任务")
        except Exception as e:
            logger.error(f"获取分页数据失败: {str(e)}")
            raise HTTPException(status_code=500, detail=f"获取分页数据失败: {str(e)}")
        
        # 构造响应数据
        response_tasks = []
        for task in tasks:
            try:
                task_response = SearchTaskResponse.model_validate(task)
                response_tasks.append(task_response)
                logger.debug(f"成功处理任务 {task.id}")
            except Exception as e:
                logger.error(f"处理任务 {task.id} 时出错: {str(e)}", exc_info=True)
                continue
        
        logger.info(f"成功构造 {len(response_tasks)} 个任务响应数据")
        
        # 构造最终响应
        try:
            response = SearchTaskListResponse(
                data=response_tasks,
                total=total,
                page=page,
                page_size=pageSize
            )
            logger.info("搜索任务列表获取成功")
            return response.model_dump()
        except Exception as e:
            logger.error(f"构造最终响应失败: {str(e)}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"构造响应失败: {str(e)}")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取搜索任务列表失败: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"获取搜索任务列表失败: {str(e)}"
        )

@router.get("/status", response_model=List[SearchTaskResponse])
async def get_tasks_status(
    ids: str,
    db: Session = Depends(get_db)
):
    """获取多个任务的状态"""
    try:
        task_ids = [int(id) for id in ids.split(",")]
        tasks = db.query(SearchTask).filter(SearchTask.id.in_(task_ids)).all()
        return [SearchTaskResponse.model_validate(task) for task in tasks]
    except Exception as e:
        logger.error(f"获取任务状态失败: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"获取任务状态失败: {str(e)}"
        )

@router.get("/{task_id}", response_model=SearchTaskResponse)
async def get_search_task(task_id: int, db: Session = Depends(get_db)):
    """获取搜索任务详情"""
    task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return SearchTaskResponse.model_validate(task)

@router.put("/{task_id}", response_model=SearchTaskResponse)
async def update_search_task(
    task_id: int,
    task_update: SearchTaskUpdate,
    db: Session = Depends(get_db)
):
    """更新搜索任务状态"""
    try:
        db_task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
        if not db_task:
            raise HTTPException(status_code=404, detail="任务不存在")
        
        logger.info(f"更新搜索任务状态 - task_id: {task_id}, update: {task_update.model_dump()}")
        logger.info(f"当前任务状态 - is_completed: {db_task.is_completed}, search_params: {db_task.search_params}")
        
        # 如果任务完成，将搜索关键词保存到用户的 profile_data.hashtags 中
        if task_update.is_completed and not db_task.is_completed:
            logger.info(f"搜索任务 {task_id} 完成，开始更新用户 hashtags")
            
            # 获取搜索关键词
            search_keywords = []
            if isinstance(db_task.search_params, dict):
                keywords = db_task.search_params.get('keywords', [])
                if isinstance(keywords, list):
                    search_keywords = keywords
                elif isinstance(keywords, str):
                    search_keywords = [keywords]
            
            logger.info(f"获取到的搜索关键词: {search_keywords}")
            
            if not search_keywords:
                logger.warning(f"任务 {task_id} 没有搜索关键词")
                
            # 获取与任务关联的用户
            tag = db_task.name
            users = db.query(User).filter(cast(User.tags, String).like(f'%{tag}%')).all()
            logger.info(f"找到 {len(users)} 个关联用户")
            
            # 更新每个用户的 hashtags
            for user in users:
                try:
                    # 确保 profile_data 是字典
                    if not user.profile_data:
                        user.profile_data = {}
                    
                    # 获取现有的 hashtags，确保是列表
                    current_hashtags = user.profile_data.get('hashtags', [])
                    if not isinstance(current_hashtags, list):
                        current_hashtags = []
                    
                    logger.info(f"用户 {user.id} 当前的 hashtags: {current_hashtags}")
                    
                    # 添加新的 hashtags，去重
                    new_hashtags = list(set(current_hashtags + search_keywords))
                    user.profile_data['hashtags'] = new_hashtags
                    
                    logger.info(f"更新用户 {user.id} 的 hashtags: {new_hashtags}")
                except Exception as e:
                    logger.error(f"更新用户 {user.id} 的 hashtags 失败: {str(e)}")
                    continue
        
        # 更新任务状态
        for key, value in task_update.model_dump(exclude_unset=True).items():
            setattr(db_task, key, value)
        
        if task_update.is_completed:
            db_task.completed_at = datetime.utcnow()
        
        db.commit()
        db.refresh(db_task)
        
        return SearchTaskResponse.model_validate(db_task)
    except Exception as e:
        logger.error(f"更新搜索任务失败: {str(e)}")
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"更新搜索任务失败: {str(e)}"
        )

@router.delete("/{task_id}")
async def delete_search_task(task_id: int, db: Session = Depends(get_db)):
    """删除搜索任务"""
    try:
        db_task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
        if not db_task:
            raise HTTPException(status_code=404, detail="任务不存在")
        
        if db_task.status == "running":
            raise HTTPException(status_code=400, detail="无法删除运行中的任务")
        
        db.delete(db_task)
        db.commit()
        return {"message": "任务已删除"}
    except Exception as e:
        logger.error(f"删除搜索任务失败: {str(e)}")
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"删除搜索任务失败: {str(e)}"
        )

@router.get("/{task_id}/results")
async def get_search_results(
    task_id: int,
    page: int = 1,
    pageSize: int = 10,
    keyword: str = None,
    db: Session = Depends(get_db)
):
    """获取搜索任务的结果"""
    try:
        logger.info(f"开始获取搜索任务 {task_id} 的结果")
        
        # 检查任务是否存在
        task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
        if not task:
            logger.error(f"任务 {task_id} 不存在")
            raise HTTPException(status_code=404, detail="任务不存在")
            
        logger.info(f"找到任务: {task.name}, 状态: {task.status}")
        
        # 使用search_task_users关联表查询与任务关联的用户
        query = db.query(User).join(
            search_task_users,
            User.id == search_task_users.c.user_id
        ).filter(
            search_task_users.c.search_task_id == task_id
        )

        # 如果提供了关键词，添加搜索条件
        if keyword:
            query = query.filter(or_(
                User.username.ilike(f"%{keyword}%"),
                User.display_name.ilike(f"%{keyword}%")
            ))
        
        # 获取总数
        total = query.count()
        logger.info(f"找到关联的用户总数: {total}")
        
        # 分页
        users = query.offset((page - 1) * pageSize).limit(pageSize).all()
        logger.info(f"当前页({page})获取到 {len(users)} 个用户")
        
        # 构造响应数据
        user_responses = []
        for user in users:
            try:
                # 确保 tags 是列表
                tags = user.tags if isinstance(user.tags, list) else []
                # 确保 profile_data 是字典
                profile_data = user.profile_data if isinstance(user.profile_data, dict) else {}
                
                # 确保 matched_posts 存在于 profile_data 中
                if 'matched_posts' not in profile_data:
                    profile_data['matched_posts'] = []
                
                user_response = {
                    "id": user.id,
                    "platform": user.platform,
                    "username": user.username,
                    "display_name": user.display_name,
                    "tags": tags,
                    "profile_data": profile_data,
                    "created_at": user.created_at,
                    "updated_at": user.updated_at
                }
                user_responses.append(user_response)
            except Exception as e:
                logger.error(f"处理用户 {user.id} 数据时出错: {str(e)}")
                continue
        
        logger.info(f"成功构造 {len(user_responses)} 个用户响应数据")
        
        response_data = {
            "data": user_responses,
            "total": total,
            "page": page,
            "pageSize": pageSize
        }
        
        logger.info(f"返回数据: {response_data}")
        return response_data
        
    except Exception as e:
        logger.error(f"获取搜索结果失败: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"获取搜索结果失败: {str(e)}"
        )

@router.post("/{task_id}/start")
async def start_search_task(
    task_id: int,
    db: Session = Depends(get_db)
):
    """启动搜索任务"""
    task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    
    if task.status == "running":
        raise HTTPException(status_code=400, detail="任务已在运行中")
    
    task.status = "running"
    task.is_completed = False
    task.error_message = None
    db.commit()
    
    # TODO: 启动异步任务执行搜索
    
    return {"message": "任务已启动"}

@router.post("/{task_id}/stop")
async def stop_search_task(
    task_id: int,
    db: Session = Depends(get_db)
):
    """停止搜索任务"""
    task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    
    if task.status != "running":
        raise HTTPException(status_code=400, detail="任务未在运行")
    
    task.status = "stopped"
    db.commit()
    
    return {"message": "任务已停止"}

@router.get("/stats", response_model=DashboardStats)
async def get_dashboard_stats(db: Session = Depends(get_db)):
    """获取仪表盘统计数据"""
    try:
        # 计算活跃时间范围（最近7天）
        active_time = datetime.utcnow() - timedelta(days=7)
        
        # 获取用户统计
        total_users = db.query(User).count()
        active_users = db.query(User).filter(User.last_active > active_time).count()
        
        # 获取任务统计
        total_tasks = db.query(SearchTask).count()
        running_tasks = db.query(SearchTask).filter(
            SearchTask.status == "running"
        ).count()
        
        # 获取模板统计（假设有Template模型）
        total_templates = db.query(Template).count()
        active_templates = db.query(Template).filter(
            Template.is_active == True
        ).count()
        
        # 获取消息统计（假设有Message模型）
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
        return [ActivityResponse.model_validate(activity) for activity in activities]
    except Exception as e:
        logger.error(f"获取最近活动记录失败: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"获取最近活动记录失败: {str(e)}"
        )