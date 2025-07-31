from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from services.instagram import InstagramMessageService
from models.database import get_db, SessionLocal
from models.models import User, Platform, MessageTask, TaskStatus, UserGroup, UserGroupMember, Message, MessageStatus
from models.template import MessageTemplate
from schemas.templates import TemplateResponse
from schemas.message_tasks import MessageTaskCreate, MessageTaskResponse, MessageTaskSettings
import asyncio
import logging
from datetime import datetime
from sqlalchemy import or_
import time

router = APIRouter(tags=["messages"])
logger = logging.getLogger(__name__)

class MessageRequest(BaseModel):
    username: str
    message: str

class BulkMessageRequest(BaseModel):
    messages: List[MessageRequest]

class MessageTaskSettings(BaseModel):
    interval: int = 60  # 发送间隔（秒）
    daily_limit: int = 50  # 每日发送限制

class MessageTaskCreate(BaseModel):
    name: str
    template_id: int
    user_ids: Optional[List[int]] = None
    group_ids: Optional[List[int]] = None
    settings: MessageTaskSettings
    variables: Optional[Dict[str, str]] = None  # 添加变量映射字段

class MessageTaskResponse(BaseModel):
    id: int
    name: str
    template: TemplateResponse
    total_users: int
    success_count: int = 0
    failed_count: int = 0
    status: str = "pending"
    progress: float = 0
    speed: Optional[float] = None
    created_at: str
    updated_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None

    class Config:
        from_attributes = True

class TaskStatusUpdate(BaseModel):
    id: int
    status: str
    progress: float
    success_count: int
    failed_count: int
    speed: Optional[float] = None

@router.post("/bulk")
async def send_bulk_messages(request: BulkMessageRequest):
    """批量发送消息"""
    service = InstagramMessageService()
    results = await service.send_bulk_messages(
        messages=[{"username": msg.username, "message": msg.message} for msg in request.messages],
        skip_validation=True
    )
    return results

@router.get("/message-tasks", response_model=dict)
async def get_message_tasks(
    keyword: Optional[str] = None,
    page: int = 1,
    pageSize: int = 10,
    db: Session = Depends(get_db)
):
    """获取消息任务列表"""
    try:
        logger.info(f"开始获取消息任务列表, 参数: keyword={keyword}, page={page}, pageSize={pageSize}")
        query = db.query(MessageTask).order_by(MessageTask.created_at.desc())
        
        # 检查并更新运行中任务的状态
        running_tasks = query.filter(MessageTask.status == TaskStatus.RUNNING).all()
        for task in running_tasks:
            if task.progress >= 100:
                task.status = TaskStatus.COMPLETED
                task.completed_at = datetime.utcnow()
                logger.info(f"任务 {task.id} 已完成，更新状态为已完成")
                db.commit()
        
        if keyword:
            query = query.filter(MessageTask.name.ilike(f"%{keyword}%"))
        
        total = query.count()
        logger.info(f"找到 {total} 个任务")
        
        tasks = query.offset((page - 1) * pageSize).limit(pageSize).all()
        logger.info(f"当前页面任务数量: {len(tasks)}")
        
        response_tasks = []
        for task in tasks:
            try:
                logger.info(f"处理任务 {task.id}, 状态: {task.status}, 模板ID: {task.template_id}")
                template = db.query(MessageTemplate).filter(MessageTemplate.id == task.template_id).first()
                if not template:
                    logger.warning(f"任务 {task.id} 的模板 {task.template_id} 不存在")
                    continue
                
                # 构造任务数据
                task_data = {
                    'id': task.id,
                    'name': task.name,
                    'template': {
                        "id": template.id,
                        "name": template.name,
                        "content": template.content,
                        "variables": template.variables or [],
                        "platform": template.platform.value if template.platform else None,
                        "is_default": template.is_default,
                        "is_active": template.is_active,
                        "created_by": template.created_by,
                        "created_at": template.created_at.isoformat() if template.created_at else None,
                        "updated_at": template.updated_at.isoformat() if template.updated_at else None
                    },
                    'total_users': task.total_users,
                    'success_count': task.success_count,
                    'failed_count': task.failed_count,
                    'status': task.status.value,
                    'progress': task.progress,
                    'speed': task.speed,
                    'created_at': task.created_at.isoformat() if task.created_at else None,
                    'updated_at': task.updated_at.isoformat() if task.updated_at else None,
                    'started_at': task.started_at.isoformat() if task.started_at else None,
                    'completed_at': task.completed_at.isoformat() if task.completed_at else None
                }
                response_tasks.append(task_data)
            except Exception as task_error:
                logger.error(f"处理任务 {task.id} 时出错: {str(task_error)}", exc_info=True)
                continue
        
        response = {
            "data": response_tasks,
            "total": total,
            "page": page,
            "pageSize": pageSize
        }
        logger.info(f"返回响应数据: {response}")
        return response
    except Exception as e:
        logger.error(f"获取消息任务列表失败: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/message-tasks", response_model=MessageTaskResponse)
async def create_message_task(task: MessageTaskCreate, db: Session = Depends(get_db)):
    """创建新的消息任务"""
    try:
        logger.info(f"开始创建消息任务，接收到的数据: {task.dict()}")
        
        # 验证模板
        template = db.query(MessageTemplate).filter(MessageTemplate.id == task.template_id).first()
        if not template:
            logger.error(f"模板不存在: {task.template_id}")
            raise HTTPException(status_code=404, detail="模板不存在")
        
        # 收集所有目标用户ID
        target_user_ids = set()
        
        # 处理直接指定的用户
        if task.user_ids:
            logger.info(f"处理指定用户: {task.user_ids}")
            users = db.query(User).filter(User.id.in_(task.user_ids)).all()
            if len(users) != len(task.user_ids):
                logger.error("部分用户不存在")
                raise HTTPException(status_code=404, detail="部分用户不存在")
            target_user_ids.update(task.user_ids)
        
        # 处理用户组
        if task.group_ids:
            logger.info(f"处理用户组: {task.group_ids}")
            groups = db.query(UserGroup).filter(UserGroup.id.in_(task.group_ids)).all()
            if len(groups) != len(task.group_ids):
                logger.error("部分用户组不存在")
                raise HTTPException(status_code=404, detail="部分用户组不存在")
            
            # 获取组内所有用户
            group_members = db.query(UserGroupMember.user_id).filter(
                UserGroupMember.group_id.in_(task.group_ids)
            ).all()
            target_user_ids.update([member[0] for member in group_members])
        
        # 验证是否有目标用户
        if not target_user_ids:
            logger.error("未指定目标用户")
            raise HTTPException(status_code=400, detail="请至少选择一个用户或用户组")
        
        logger.info(f"最终目标用户数量: {len(target_user_ids)}")
        
        try:
            # 创建新任务
            new_task = MessageTask(
                name=task.name,
                template_id=task.template_id,
                user_ids=list(target_user_ids),
                group_ids=task.group_ids if task.group_ids else None,
                total_users=len(target_user_ids),
                status=TaskStatus.PENDING,
                progress=0,
                success_count=0,
                failed_count=0,
                settings=task.settings.dict(),
                variables=task.variables or {},
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow()
            )
            
            db.add(new_task)
            db.commit()
            db.refresh(new_task)
            
            logger.info(f"消息任务创建成功: {new_task.id}")
            
            # 构造模板响应
            template_response = {
                "id": template.id,
                "name": template.name,
                "content": template.content,
                "variables": template.variables or [],
                "platform": template.platform.value if template.platform else None,
                "is_default": template.is_default,
                "is_active": template.is_active,
                "created_by": template.created_by,
                "created_at": template.created_at.isoformat() if template.created_at else None,
                "updated_at": template.updated_at.isoformat() if template.updated_at else None
            }
            
            # 构造任务响应
            response = {
                "id": new_task.id,
                "name": new_task.name,
                "template": template_response,
                "total_users": new_task.total_users,
                "success_count": new_task.success_count,
                "failed_count": new_task.failed_count,
                "status": new_task.status.value,
                "progress": new_task.progress,
                "speed": new_task.speed,
                "created_at": new_task.created_at.isoformat() if new_task.created_at else None,
                "updated_at": new_task.updated_at.isoformat() if new_task.updated_at else None,
                "started_at": new_task.started_at.isoformat() if new_task.started_at else None,
                "completed_at": new_task.completed_at.isoformat() if new_task.completed_at else None
            }
            
            logger.info(f"返回响应数据: {response}")
            return response
            
        except Exception as e:
            logger.error(f"创建任务记录失败: {str(e)}", exc_info=True)
            db.rollback()
            raise HTTPException(status_code=500, detail=f"创建任务记录失败: {str(e)}")
            
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"创建消息任务失败: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/message-tasks/{task_id}/start")
async def start_task(task_id: int, db: Session = Depends(get_db)):
    """启动消息任务"""
    try:
        # 获取任务信息
        task = db.query(MessageTask).filter(MessageTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        
        # 检查任务状态
        if task.status == TaskStatus.RUNNING:
            raise HTTPException(status_code=400, detail="任务已在运行中")
        
        # 获取模板
        template = db.query(MessageTemplate).filter(MessageTemplate.id == task.template_id).first()
        if not template:
            raise HTTPException(status_code=404, detail="模板不存在")
        
        # 获取用户列表
        users = db.query(User).filter(User.id.in_(task.user_ids)).all()
        if not users:
            raise HTTPException(status_code=404, detail="未找到目标用户")
            
        # 清理已完成但状态未更新的任务
        running_tasks = db.query(MessageTask).filter(
            MessageTask.status == TaskStatus.RUNNING
        ).all()
        
        active_running_tasks = 0
        for running_task in running_tasks:
            # 检查任务是否真的还在运行
            if running_task.progress >= 100 or (
                running_task.started_at and 
                (datetime.utcnow() - running_task.started_at).total_seconds() > 3600
            ):
                # 如果任务进度100%或者已经运行超过1小时，认为已完成
                running_task.status = TaskStatus.COMPLETED
                running_task.completed_at = datetime.utcnow()
                db.commit()
            else:
                active_running_tasks += 1
        
        # 检查并发任务数
        MAX_CONCURRENT_TASKS = 3  # 最大并发任务数
        if active_running_tasks >= MAX_CONCURRENT_TASKS:
            raise HTTPException(status_code=400, detail="系统正忙，当前运行的任务数已达到上限，请等待其他任务完成后再试")
        
        # 更新任务状态
        task.status = TaskStatus.RUNNING
        task.progress = 0
        task.success_count = 0
        task.failed_count = 0
        task.started_at = datetime.utcnow()
        db.commit()
        
        # 启动异步任务
        asyncio.create_task(execute_message_task(task_id))
        
        return {"message": "任务已启动"}
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"启动任务失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"启动任务失败: {str(e)}")

@router.post("/message-tasks/{task_id}/stop")
async def stop_task(task_id: int, db: Session = Depends(get_db)):
    """停止消息任务"""
    try:
        # 获取任务信息
        task = db.query(MessageTask).filter(MessageTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        
        # 检查任务状态
        if task.status != TaskStatus.RUNNING:
            raise HTTPException(status_code=400, detail="任务未在运行")
        
        # 更新任务状态
        task.status = TaskStatus.STOPPED
        task.stopped_at = datetime.utcnow()
        db.commit()
        
        return {"message": "任务已停止"}
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"停止任务失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"停止任务失败: {str(e)}")

@router.get("/message-tasks/status")
async def get_tasks_status(ids: str, db: Session = Depends(get_db)):
    """获取多个任务的状态"""
    try:
        task_ids = [int(id) for id in ids.split(",")]
        tasks = db.query(MessageTask).filter(MessageTask.id.in_(task_ids)).all()
        
        return [
            TaskStatusUpdate(
                id=task.id,
                status=task.status.value,
                progress=task.progress,
                success_count=task.success_count,
                failed_count=task.failed_count,
                speed=task.speed
            )
            for task in tasks
        ]
    except Exception as e:
        logger.error(f"获取任务状态失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"获取任务状态失败: {str(e)}")

@router.delete("/message-tasks/{task_id}")
async def delete_task(task_id: int, db: Session = Depends(get_db)):
    """删除消息任务"""
    try:
        # 获取任务信息
        task = db.query(MessageTask).filter(MessageTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        
        # 检查任务状态
        if task.status == TaskStatus.RUNNING:
            raise HTTPException(status_code=400, detail="无法删除运行中的任务")
        
        # 删除任务
        db.delete(task)
        db.commit()
        
        return {"message": "任务已删除"}
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"删除任务失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"删除任务失败: {str(e)}")

@router.get("/message-tasks/{task_id}/users")
async def get_task_users(task_id: int, db: Session = Depends(get_db)):
    """获取任务的目标用户列表"""
    try:
        # 获取任务信息
        task = db.query(MessageTask).filter(MessageTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        
        # 获取用户列表
        users = db.query(User).filter(User.id.in_(task.user_ids)).all()
        
        # 获取消息发送状态
        messages = db.query(Message).filter(
            Message.user_id.in_(task.user_ids),
            Message.template_id == task.template_id
        ).all()
        
        # 构建用户状态映射
        user_status = {
            msg.user_id: msg.status.value == 'sent'
            for msg in messages
        }
        
        # 构建响应数据
        response_data = []
        for user in users:
            response_data.append({
                "username": user.username,
                "display_name": user.display_name,
                "status": "success" if user_status.get(user.id, False) else "failed"
            })
        
        return {
            "data": response_data,
            "total": len(response_data)
        }
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"获取任务用户列表失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

async def execute_message_task(task_id: int):
    """执行消息发送任务"""
    service = InstagramMessageService()
    db = SessionLocal()
    task = None
    max_retries = 3  # 最大重试次数
    
    try:
        # 获取任务信息
        task = db.query(MessageTask).filter(MessageTask.id == task_id).first()
        if not task:
            logger.error(f"任务 {task_id} 不存在")
            return
        
        # 获取模板
        template = db.query(MessageTemplate).filter(MessageTemplate.id == task.template_id).first()
        if not template:
            logger.error(f"模板 {task.template_id} 不存在")
            task.status = TaskStatus.FAILED
            task.error_message = "模板不存在"
            db.commit()
            return
        
        # 获取用户列表
        users = db.query(User).filter(User.id.in_(task.user_ids)).all()
        if not users:
            logger.error(f"未找到目标用户")
            task.status = TaskStatus.FAILED
            task.error_message = "未找到目标用户"
            db.commit()
            return

        # 添加资源限制
        MAX_CONCURRENT_TASKS = 3  # 最大并发任务数
        MAX_USERS_PER_TASK = 1000  # 每个任务最大用户数
        MIN_INTERVAL = 30  # 最小发送间隔(秒)
        MAX_DAILY_LIMIT = 200  # 每日最大发送限制
        
        # 检查并发任务数
        running_tasks = db.query(MessageTask).filter(
            MessageTask.status == TaskStatus.RUNNING
        ).count()
        
        if running_tasks >= MAX_CONCURRENT_TASKS:
            logger.error(f"超过最大并发任务数限制")
            task.status = TaskStatus.FAILED
            task.error_message = "系统正忙,请稍后再试"
            db.commit()
            return
            
        # 限制用户数量
        if len(users) > MAX_USERS_PER_TASK:
            users = users[:MAX_USERS_PER_TASK]
            logger.warning(f"任务用户数超限,已截取前 {MAX_USERS_PER_TASK} 个用户")
            
        # 验证并修正任务设置
        if not task.settings:
            task.settings = {}
        task.settings["interval"] = max(task.settings.get("interval", MIN_INTERVAL), MIN_INTERVAL)
        task.settings["daily_limit"] = min(task.settings.get("daily_limit", MAX_DAILY_LIMIT), MAX_DAILY_LIMIT)
        
        # 初始化计数器
        total_users = len(users)
        success_count = 0
        failed_count = 0
        start_time = time.time()
        all_completed = True
        
        # 遍历用户发送消息
        for i, user in enumerate(users):
            # 检查是否达到每日限制
            if success_count >= task.settings["daily_limit"]:
                logger.info(f"已达到每日发送限制 {task.settings['daily_limit']}")
                break
                
            retry_count = 0
            success = False
            last_error = None
            
            # 检查任务是否被停止
            task = db.query(MessageTask).filter(MessageTask.id == task_id).first()
            if task.status != TaskStatus.RUNNING:
                logger.info(f"任务 {task_id} 已停止")
                all_completed = False
                break
            
            while retry_count < max_retries and not success:
                try:
                    # 获取原始消息内容
                    message = template.content
                    
                    # 处理消息内容：去除首尾引号，处理换行符
                    message = message.strip()  # 去除首尾空白字符
                    if message.startswith(("'", '"')) and message.endswith(("'", '"')):
                        message = message[1:-1]  # 去除首尾引号
                    
                    # 替换特殊的换行符表示为实际的换行符
                    message = message.replace('\\n', '\n')
                    message = message.replace('\\r', '')
                    
                    # 替换用户相关变量
                    if template.variables:
                        for var in template.variables:
                            placeholder = "{" + var + "}"
                            if var == "username":
                                message = message.replace(placeholder, user.username)
                            elif var == "display_name":
                                message = message.replace(placeholder, user.display_name or user.username)
                            elif var in user.profile_data:
                                message = message.replace(placeholder, str(user.profile_data[var]))
                    
                    # 替换任务级别变量
                    if task.variables:
                        for var, value in task.variables.items():
                            placeholder = "{" + var + "}"
                            if value is not None:  # 只替换非空值
                                message = message.replace(placeholder, str(value))
                    
                    # 最后再次处理可能出现的多余引号
                    message = message.strip("'").strip('"')
                    
                    logger.info(f"处理后的消息内容: {message}")
                    
                    # 发送消息
                    logger.info(f"正在发送消息给用户 {user.username} (第 {retry_count + 1} 次尝试)")
                    result = await service.send_message(user.username, message)
                    
                    if result.get("success"):
                        success_count += 1
                        success = True
                        logger.info(f"发送消息给 {user.username} 成功")
                        
                        # 创建消息记录
                        try:
                            message_record = Message(
                                user_id=user.id,
                                template_id=template.id,
                                content=message,
                                status=MessageStatus.SENT,
                                sent_at=datetime.utcnow(),
                                delivered_at=datetime.utcnow()
                            )
                            db.add(message_record)
                            db.commit()
                            logger.info(f"已创建消息记录: user_id={user.id}, template_id={template.id}")
                        except Exception as e:
                            logger.error(f"创建消息记录失败: {str(e)}")
                            db.rollback()
                    else:
                        retry_count += 1
                        last_error = result.get("error")
                        if retry_count < max_retries:
                            logger.warning(f"发送消息给 {user.username} 失败，将在 5 秒后重试: {last_error}")
                            await asyncio.sleep(5)  # 重试前等待5秒
                        else:
                            failed_count += 1
                            logger.error(f"发送消息给 {user.username} 失败，已达到最大重试次数: {last_error}")
                    
                except Exception as e:
                    retry_count += 1
                    last_error = str(e)
                    if retry_count < max_retries:
                        logger.warning(f"处理用户 {user.username} 时出错，将在 5 秒后重试: {last_error}")
                        await asyncio.sleep(5)
                    else:
                        failed_count += 1
                        logger.error(f"处理用户 {user.username} 时出错，已达到最大重试次数: {last_error}")
                
                # 更新进度
                progress = ((i + 1) / total_users) * 100
                elapsed_time = time.time() - start_time
                speed = (success_count + failed_count) / (elapsed_time / 60) if elapsed_time > 0 else 0
                
                # 更新任务状态
                task.progress = progress
                task.success_count = success_count
                task.failed_count = failed_count
                task.speed = speed
                task.error_message = last_error if not success else None
                db.commit()
            
            # 检查是否需要暂停（根据设置的间隔时间）
            if task.settings and task.settings.get("interval") and success:
                await asyncio.sleep(task.settings["interval"])
        
        # 更新任务完成状态
        task = db.query(MessageTask).filter(MessageTask.id == task_id).first()
        if task and task.status == TaskStatus.RUNNING:  # 确保任务仍在运行中
            if all_completed:
                task.status = TaskStatus.COMPLETED
                logger.info(f"任务 {task_id} 已完成，成功: {success_count}, 失败: {failed_count}")
            else:
                task.status = TaskStatus.STOPPED
                logger.info(f"任务 {task_id} 已停止，成功: {success_count}, 失败: {failed_count}")
            task.completed_at = datetime.utcnow()
            task.progress = 100.0
            db.commit()
        
    except Exception as e:
        logger.error(f"执行任务 {task_id} 时出错: {str(e)}")
        if task:
            task.status = TaskStatus.FAILED
            task.error_message = str(e)
            db.commit()
    finally:
        db.close() 