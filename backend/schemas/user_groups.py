from typing import Optional, List
from datetime import datetime
from models.models import Platform
from .common import BaseSchema

class UserGroupCreate(BaseSchema):
    """创建用户组请求模型"""
    name: str
    description: Optional[str] = None
    platform: Platform

class UserGroupUpdate(BaseSchema):
    """更新用户组请求模型"""
    name: Optional[str] = None
    description: Optional[str] = None
    platform: Optional[Platform] = None

class UserGroupResponse(BaseSchema):
    """用户组响应模型"""
    id: int
    name: str
    description: Optional[str] = None
    platform: Platform
    user_count: int = 0
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_orm(cls, obj):
        """从 ORM 对象创建实例"""
        return cls(
            id=getattr(obj, 'id', None),
            name=getattr(obj, 'name', None),
            description=getattr(obj, 'description', None),
            platform=getattr(obj, 'platform', None),
            user_count=getattr(obj, 'user_count', 0),
            created_by=getattr(obj, 'created_by', None),
            created_at=getattr(obj, 'created_at', None),
            updated_at=getattr(obj, 'updated_at', None)
        )

class UserGroupListResponse(BaseSchema):
    """用户组列表响应模型"""
    data: List[UserGroupResponse]
    total: int = 0
    page: int = 1
    page_size: int = 10

    @classmethod
    def from_orm(cls, obj):
        """从 ORM 对象创建实例"""
        if isinstance(obj, dict):
            # 确保 data 是列表
            data = obj.get('data', [])
            if not isinstance(data, list):
                data = [data] if data is not None else []
            
            # 转换每个元素为 UserGroupResponse
            data = [
                UserGroupResponse.from_orm(item) if not isinstance(item, UserGroupResponse) else item
                for item in data
            ]
            
            return cls(
                data=data,
                total=obj.get('total', len(data)),
                page=obj.get('page', 1),
                page_size=obj.get('page_size', 10)
            )
        
        # 如果是其他对象，尝试从属性获取数据
        data = getattr(obj, 'data', [])
        if not isinstance(data, list):
            data = [data] if data is not None else []
        
        # 转换每个元素为 UserGroupResponse
        data = [
            UserGroupResponse.from_orm(item) if not isinstance(item, UserGroupResponse) else item
            for item in data
        ]
        
        return cls(
            data=data,
            total=getattr(obj, 'total', len(data)),
            page=getattr(obj, 'page', 1),
            page_size=getattr(obj, 'page_size', 10)
        ) 