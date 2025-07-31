from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy import or_, text, String
from typing import List, Optional, Dict
from datetime import datetime
import logging
from urllib.parse import quote

from models.database import get_db
from models.models import User, Platform
from schemas.users import UserResponse, UserCreate, UserBase, UserProfile, UserUpdate, TagResponse
from pydantic import BaseModel

router = APIRouter(tags=["users"])

logger = logging.getLogger(__name__)

def process_profile_data(profile_data: dict, request: Request) -> UserProfile:
    """处理用户资料数据，转换头像URL"""
    if profile_data and profile_data.get('avatar_url'):
        # 将Instagram的图片URL转换为通过我们的代理服务加载
        encoded_url = quote(profile_data['avatar_url'])
        profile_data['avatar_url'] = f"{request.base_url}api/proxy/image?url={encoded_url}"
    return UserProfile(**profile_data) if profile_data else UserProfile()

@router.get("/tags")
async def get_all_tags(db: Session = Depends(get_db)) -> List[Dict[str, str]]:
    """获取所有已存在的标签"""
    try:
        logger.info("开始获取所有标签")
        # 查询所有用户的tags字段
        users = db.query(User).all()
        all_tags = set()
        
        # 收集所有标签
        for user in users:
            if user.tags and isinstance(user.tags, list):
                all_tags.update(user.tags)
        
        # 转换为前端需要的格式并排序
        tag_list = sorted(list(all_tags))
        logger.info(f"找到 {len(tag_list)} 个标签")
        logger.info(f"标签列表: {tag_list}")
        
        # 转换为前端需要的格式
        response_data = [{"value": tag, "label": tag} for tag in tag_list]
        logger.info(f"返回数据: {response_data}")
        
        return response_data
    except Exception as e:
        logger.error(f"获取标签列表失败: {str(e)}")
        return []

@router.get("/search", response_model=dict)
async def search_users(
    keyword: str,
    db: Session = Depends(get_db)
):
    """搜索用户"""
    try:
        users = db.query(User).filter(or_(
            User.username.ilike(f"%{keyword}%"),
            User.display_name.ilike(f"%{keyword}%")
        )).all()
        
        # 转换为响应模型
        user_responses = [UserResponse.from_orm(user) for user in users]
        
        return {
            "data": user_responses,
            "total": len(user_responses)
        }
    except Exception as e:
        logger.error(f"搜索用户失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: int, db: Session = Depends(get_db)):
    """获取用户详情"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return UserResponse.from_orm(user)

@router.get("", response_model=dict)
async def get_users(
    keyword: Optional[str] = None,
    platform: Optional[Platform] = None,
    tags: Optional[List[str]] = Query(None, alias="tags[]"),
    tag_logic: Optional[str] = 'or',
    contacted: Optional[bool] = None,
    ids: Optional[str] = None,
    page: int = 1,
    pageSize: int = 10,
    db: Session = Depends(get_db)
):
    """获取用户列表"""
    try:
        query = db.query(User)
        logger.info(f"收到的请求参数 - tags: {tags}, tag_logic: {tag_logic}, contacted: {contacted}")
        
        # 通过ID列表查询
        if ids:
            user_ids = [int(id) for id in ids.split(',')]
            query = query.filter(User.id.in_(user_ids))
            users = query.all()
            return {
                "data": [UserResponse.from_orm(user) for user in users],
                "total": len(user_ids),
                "page": 1,
                "pageSize": len(user_ids)
            }
        
        # 关键词搜索
        if keyword:
            query = query.filter(or_(
                User.username.ilike(f"%{keyword}%"),
                User.display_name.ilike(f"%{keyword}%")
            ))
        
        # 平台筛选
        if platform:
            query = query.filter(User.platform == platform)
            
        # 联系状态筛选
        if contacted is not None:
            logger.info(f"筛选联系状态: {contacted}")
            query = query.filter(User.contacted == contacted)
        
        # 获取所有用户
        all_users = query.all()
        filtered_users = []

        # 标签筛选
        if tags and len(tags) > 0:
            logger.info(f"标签筛选 - 标签: {tags}, 逻辑: {tag_logic}")
            
            for user in all_users:
                if not user.tags:
                    continue
                    
                if tag_logic and tag_logic.lower() == 'and':
                    # AND 逻辑: 用户必须包含所有指定的标签
                    if all(tag in user.tags for tag in tags):
                        filtered_users.append(user)
                else:
                    # OR 逻辑: 用户包含任一指定的标签
                    if any(tag in user.tags for tag in tags):
                        filtered_users.append(user)
        else:
            filtered_users = all_users

        # 计算总数和分页
        total = len(filtered_users)
        start = (page - 1) * pageSize
        end = start + pageSize
        paginated_users = filtered_users[start:end]

        # 转换为响应模型
        user_responses = []
        for user in paginated_users:
            try:
                user_response = UserResponse.from_orm(user)
                user_responses.append(user_response)
            except Exception as e:
                logger.error(f"转换用户数据失败: {str(e)}, user_id: {user.id}")
                continue

        return {
            "data": user_responses,
            "total": total,
            "page": page,
            "pageSize": pageSize
        }
        
    except Exception as e:
        logger.error(f"获取用户列表失败: {str(e)}")
        # 即使发生错误也返回有效的响应格式
        return {
            "data": [],
            "total": 0,
            "page": page,
            "pageSize": pageSize
        }

@router.post("", response_model=UserResponse)
async def create_user(user: UserCreate, db: Session = Depends(get_db)):
    """创建用户"""
    try:
        logger.info(f"开始创建用户: {user.dict()}")
        
        # 检查用户名是否已存在
        existing_user = db.query(User).filter(
            User.platform == user.platform,
            User.username == user.username
        ).first()
        
        if existing_user:
            logger.warning(f"用户名已存在: {user.username}")
            raise HTTPException(status_code=400, detail="用户名已存在")
        
        # 创建新用户
        try:
            user_data = {
                "platform": user.platform,
                "username": user.username,
                "display_name": user.display_name or user.username,
                "tags": user.tags or [],
                "profile_data": {
                    'avatar_url': None,
                    'followers_count': 0,
                    'following_count': 0,
                    'post_count': 0,
                    'bio': None,
                    'is_verified': False,
                    'is_private': False,
                    'website': None,
                    'category': None,
                    'profile_url': None
                },
                "created_at": datetime.utcnow(),
                "updated_at": datetime.utcnow()
            }
            logger.info(f"准备创建用户，数据: {user_data}")
            
            db_user = User(**user_data)
            db.add(db_user)
            db.commit()
            db.refresh(db_user)
            
            logger.info(f"用户创建成功: {db_user.id}")
            return UserResponse.from_orm(db_user)
            
        except Exception as e:
            logger.error(f"创建用户记录时出错: {str(e)}", exc_info=True)
            db.rollback()
            raise HTTPException(status_code=500, detail=f"创建用户记录失败: {str(e)}")
            
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"创建用户过程中出错: {str(e)}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    user_update: UserUpdate,
    db: Session = Depends(get_db)
):
    """更新用户信息"""
    try:
        # 记录原始请求数据
        logger.info(f"收到更新用户请求 - user_id: {user_id}")
        logger.info(f"更新数据: {user_update.dict()}")
        
        # 查找用户
        db_user = db.query(User).filter(User.id == user_id).first()
        if not db_user:
            logger.error(f"用户不存在: {user_id}")
            raise HTTPException(status_code=404, detail="用户不存在")
            
        # 记录更新前的状态
        logger.info(f"更新前的用户数据: {UserResponse.from_orm(db_user).dict()}")
        
        # 更新用户数据
        update_data = user_update.dict(exclude_unset=True)
        
        # 特别处理contacted字段
        if 'contacted' in update_data:
            logger.info(f"更新contacted字段: {update_data['contacted']}")
            db_user.contacted = update_data['contacted']
            
        # 更新其他字段
        for key, value in update_data.items():
            if key != 'contacted' and hasattr(db_user, key):
                setattr(db_user, key, value)
                
        # 更新时间戳
        db_user.updated_at = datetime.utcnow()
        
        try:
            db.commit()
            db.refresh(db_user)
            logger.info(f"用户更新成功: {user_id}")
            
            # 记录更新后的状态
            updated_user = UserResponse.from_orm(db_user)
            logger.info(f"更新后的用户数据: {updated_user.dict()}")
            
            return updated_user
            
        except Exception as e:
            logger.error(f"提交更新时出错: {str(e)}")
            db.rollback()
            raise HTTPException(status_code=500, detail=f"更新用户失败: {str(e)}")
            
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"更新用户过程中出错: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{user_id}")
async def delete_user(user_id: int, db: Session = Depends(get_db)):
    """删除用户"""
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(status_code=404, detail="用户不存在")
        
        db.delete(user)
        db.commit()
        
        return {"message": "用户已删除"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e)) 