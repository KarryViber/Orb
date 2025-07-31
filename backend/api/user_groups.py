from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List, Optional
from datetime import datetime
import logging

from models.database import get_db
from models.models import UserGroup, UserGroupMember, User, Platform
from schemas.user_groups import UserGroupCreate, UserGroupUpdate, UserGroupResponse

router = APIRouter(tags=["user-groups"])
logger = logging.getLogger(__name__)

@router.get("", response_model=dict)
async def get_user_groups(
    keyword: Optional[str] = None,
    platform: Optional[Platform] = None,
    page: int = 1,
    pageSize: int = 10,
    db: Session = Depends(get_db)
):
    """获取用户组列表"""
    try:
        # 基础查询
        query = db.query(UserGroup)
        
        # 关键词搜索
        if keyword:
            query = query.filter(UserGroup.name.ilike(f"%{keyword}%"))
        
        # 平台筛选
        if platform:
            query = query.filter(UserGroup.platform == platform)
        
        # 计算总数
        total = query.count()
        
        # 分页
        query = query.offset((page - 1) * pageSize).limit(pageSize)
        
        # 获取分页后的用户组
        groups = query.all()
        
        # 获取每个组的成员数量
        response_groups = []
        for group in groups:
            # 查询该组的成员数量
            user_count = db.query(UserGroupMember).filter(
                UserGroupMember.group_id == group.id
            ).count()
            
            response_groups.append(UserGroupResponse(
                id=group.id,
                name=group.name,
                description=group.description,
                platform=group.platform,
                user_count=user_count,
                created_by=group.created_by,
                created_at=group.created_at,
                updated_at=group.updated_at
            ))
        
        return {
            "code": 200,
            "message": "获取用户组列表成功",
            "data": {
                "items": response_groups,
                "total": total,
                "page": page,
                "pageSize": pageSize
            }
        }
        
    except Exception as e:
        logger.error(f"获取用户组列表失败: {str(e)}")
        return {
            "code": 500,
            "message": f"获取用户组列表失败: {str(e)}",
            "data": None
        }

@router.post("", response_model=UserGroupResponse)
async def create_user_group(
    group: UserGroupCreate,
    db: Session = Depends(get_db)
):
    """创建用户组"""
    try:
        db_group = UserGroup(
            name=group.name,
            description=group.description,
            platform=group.platform,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        
        db.add(db_group)
        db.commit()
        db.refresh(db_group)
        
        return UserGroupResponse(
            id=db_group.id,
            name=db_group.name,
            description=db_group.description,
            platform=db_group.platform,
            user_count=0,
            created_by=db_group.created_by,
            created_at=db_group.created_at,
            updated_at=db_group.updated_at
        )
    except Exception as e:
        db.rollback()
        logger.error(f"创建用户组失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/{group_id}", response_model=UserGroupResponse)
async def update_user_group(
    group_id: int,
    group_update: UserGroupUpdate,
    db: Session = Depends(get_db)
):
    """更新用户组信息"""
    try:
        db_group = db.query(UserGroup).filter(UserGroup.id == group_id).first()
        if not db_group:
            raise HTTPException(status_code=404, detail="用户组不存在")
        
        # 更新字段
        for field, value in group_update.dict(exclude_unset=True).items():
            setattr(db_group, field, value)
        
        db_group.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(db_group)
        
        # 获取用户数量
        user_count = db.query(UserGroupMember).filter(
            UserGroupMember.group_id == group_id
        ).count()
        
        return UserGroupResponse(
            id=db_group.id,
            name=db_group.name,
            description=db_group.description,
            platform=db_group.platform,
            user_count=user_count,
            created_by=db_group.created_by,
            created_at=db_group.created_at,
            updated_at=db_group.updated_at
        )
    except Exception as e:
        db.rollback()
        logger.error(f"更新用户组失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/{group_id}/users", response_model=dict)
async def add_users_to_group(
    group_id: int,
    user_ids: List[int],
    db: Session = Depends(get_db)
):
    """添加用户到用户组"""
    try:
        logger.info(f"添加用户到用户组 - group_id: {group_id}, user_ids: {user_ids}")
        
        # 检查请求体格式
        if not isinstance(user_ids, list):
            logger.error(f"无效的请求体格式 - user_ids: {user_ids}")
            return {
                "code": 422,
                "message": "无效的请求体格式，需要提供用户ID列表",
                "data": None
            }
        
        group = db.query(UserGroup).filter(UserGroup.id == group_id).first()
        if not group:
            logger.error(f"用户组不存在 - group_id: {group_id}")
            return {
                "code": 404,
                "message": "用户组不存在",
                "data": None
            }
        
        # 验证所有用户ID是否存在
        existing_users = db.query(User).filter(User.id.in_(user_ids)).all()
        existing_user_ids = {user.id for user in existing_users}
        invalid_user_ids = set(user_ids) - existing_user_ids
        
        if invalid_user_ids:
            logger.error(f"存在无效的用户ID - invalid_ids: {invalid_user_ids}")
            return {
                "code": 400,
                "message": f"以下用户ID无效: {list(invalid_user_ids)}",
                "data": None
            }
        
        # 获取现有成员ID列表
        existing_members = db.query(UserGroupMember.user_id).filter(
            UserGroupMember.group_id == group_id
        ).all()
        existing_member_ids = {member[0] for member in existing_members}
        
        # 计算需要添加的新成员
        new_member_ids = set(user_ids) - existing_member_ids
        
        # 添加新成员
        for user_id in new_member_ids:
            member = UserGroupMember(
                group_id=group_id,
                user_id=user_id,
                created_at=datetime.utcnow()
            )
            db.add(member)
        
        db.commit()
        
        # 获取更新后的用户数量
        user_count = db.query(UserGroupMember).filter(
            UserGroupMember.group_id == group_id
        ).count()
        
        return {
            "code": 200,
            "message": "添加用户成功",
            "data": {
                "id": group.id,
                "name": group.name,
                "description": group.description,
                "platform": group.platform,
                "user_count": user_count,
                "created_by": group.created_by,
                "created_at": group.created_at,
                "updated_at": group.updated_at
            }
        }
    except Exception as e:
        db.rollback()
        logger.error(f"添加用户到用户组失败: {str(e)}")
        return {
            "code": 500,
            "message": str(e),
            "data": None
        }

@router.delete("/{group_id}/users", response_model=dict)
async def remove_users_from_group(
    group_id: int,
    user_ids: List[int],
    db: Session = Depends(get_db)
):
    """从用户组中移除用户"""
    try:
        logger.info(f"从用户组移除用户 - group_id: {group_id}, user_ids: {user_ids}")
        
        # 检查用户组是否存在
        group = db.query(UserGroup).filter(UserGroup.id == group_id).first()
        if not group:
            return {
                "code": 404,
                "message": "用户组不存在",
                "data": None
            }
        
        # 移除用户
        db.query(UserGroupMember).filter(
            UserGroupMember.group_id == group_id,
            UserGroupMember.user_id.in_(user_ids)
        ).delete(synchronize_session=False)
        
        db.commit()
        
        # 获取更新后的用户数量
        user_count = db.query(UserGroupMember).filter(
            UserGroupMember.group_id == group_id
        ).count()
        
        return {
            "code": 200,
            "message": "移除用户成功",
            "data": {
                "id": group.id,
                "name": group.name,
                "description": group.description,
                "platform": group.platform,
                "user_count": user_count,
                "created_by": group.created_by,
                "created_at": group.created_at,
                "updated_at": group.updated_at
            }
        }
    except Exception as e:
        db.rollback()
        logger.error(f"从用户组移除用户失败: {str(e)}")
        return {
            "code": 500,
            "message": str(e),
            "data": None
        }

@router.get("/{group_id}/users", response_model=dict)
async def get_group_users(
    group_id: int,
    db: Session = Depends(get_db)
):
    """获取用户组成员列表"""
    try:
        # 获取用户组成员ID
        members = db.query(UserGroupMember.user_id).filter(
            UserGroupMember.group_id == group_id
        ).all()
        member_ids = [member[0] for member in members]
        
        # 获取用户完整信息
        users = db.query(User).filter(User.id.in_(member_ids)).all()
        
        # 构造用户信息列表
        user_list = []
        for user in users:
            user_list.append({
                "id": user.id,
                "username": user.username,
                "display_name": user.display_name,
                "platform": user.platform,
                "profile_data": user.profile_data,
                "tags": user.tags,
                "created_at": user.created_at,
                "updated_at": user.updated_at
            })
        
        return {
            "code": 200,
            "message": "获取用户组成员成功",
            "data": {
                "items": user_list,
                "total": len(user_list)
            }
        }
    except Exception as e:
        logger.error(f"获取用户组成员失败: {str(e)}")
        return {
            "code": 500,
            "message": f"获取用户组成员失败: {str(e)}",
            "data": None
        }

@router.delete("/{group_id}")
async def delete_user_group(
    group_id: int,
    db: Session = Depends(get_db)
):
    """删除用户组"""
    try:
        group = db.query(UserGroup).filter(UserGroup.id == group_id).first()
        if not group:
            raise HTTPException(status_code=404, detail="用户组不存在")
        
        db.delete(group)
        db.commit()
        
        return {"message": "用户组删除成功"}
    except Exception as e:
        logger.error(f"删除用户组失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) 