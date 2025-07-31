from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import field_validator, model_validator
from models.models import Platform
from .common import BaseSchema

class TagResponse(BaseSchema):
    """标签响应模型"""
    value: str
    label: str

    model_config = {
        "json_schema_extra": {
            "example": {
                "value": "example_tag",
                "label": "Example Tag"
            }
        }
    }

class MatchedPost(BaseSchema):
    url: str
    caption: str
    likes_count: int = 0
    comments_count: int = 0
    timestamp: str
    hashtags: Optional[List[str]] = None

class UserProfile(BaseSchema):
    avatar_url: Optional[str] = None
    followers_count: int = 0
    following_count: int = 0
    posts_count: int = 0
    bio: Optional[str] = None
    is_verified: bool = False
    is_private: bool = False
    is_business: bool = False
    website: Optional[str] = None
    category: Optional[str] = None
    profile_url: Optional[str] = None
    matched_posts: Optional[List[MatchedPost]] = None

class UserBase(BaseSchema):
    platform: Platform
    username: str
    display_name: Optional[str] = None
    tags: List[str] = []
    profile_data: dict = {}
    contacted: bool = False

class UserCreate(UserBase):
    pass

class UserUpdate(BaseSchema):
    platform: Optional[Platform] = None
    username: Optional[str] = None
    display_name: Optional[str] = None
    tags: Optional[List[str]] = None
    profile_data: Optional[Dict[str, Any]] = None
    contacted: Optional[bool] = None

class UserSearch(BaseSchema):
    platform: Optional[Platform] = None
    keyword: Optional[str] = None
    tags: Optional[List[str]] = None

class UserResponse(UserBase):
    id: int
    profile_data: Optional[UserProfile] = None
    created_at: datetime
    updated_at: datetime
    created_by: Optional[str] = None

    @classmethod
    def from_orm(cls, obj):
        """从 ORM 对象创建实例"""
        data = {
            'id': getattr(obj, 'id', None),
            'platform': getattr(obj, 'platform', None),
            'username': getattr(obj, 'username', None),
            'display_name': getattr(obj, 'display_name', None),
            'tags': getattr(obj, 'tags', []),
            'profile_data': getattr(obj, 'profile_data', None),
            'created_at': getattr(obj, 'created_at', None),
            'updated_at': getattr(obj, 'updated_at', None),
            'created_by': getattr(obj, 'created_by', None),
            'contacted': getattr(obj, 'contacted', False)
        }

        if isinstance(data['profile_data'], dict):
            data['profile_data'] = UserProfile.model_validate(data['profile_data'])

        return cls.model_validate(data) 