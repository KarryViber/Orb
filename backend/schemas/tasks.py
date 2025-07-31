from pydantic import BaseModel, Field, validator
from typing import List, Optional, Dict
from datetime import datetime
from models.models import Platform

class SearchParams(BaseModel):
    """搜索参数模型"""
    keywords: List[str]
    location: Optional[List[str]] = None
    min_followers: Optional[int] = None
    max_followers: Optional[int] = None
    min_following: Optional[int] = None
    max_following: Optional[int] = None
    min_posts: Optional[int] = None
    max_posts: Optional[int] = None
    is_verified: Optional[bool] = None
    is_private: Optional[bool] = None
    has_website: Optional[bool] = None
    category: Optional[str] = None

    model_config = {
        "from_attributes": True,
        "json_schema_extra": {
            "example": {
                "keywords": ["fashion", "style"],
                "location": ["New York"],
                "min_followers": 1000,
                "max_followers": 100000,
                "is_verified": True
            }
        }
    }

class SearchTaskCreate(BaseModel):
    """创建搜索任务请求模型"""
    name: str = Field(..., min_length=2, max_length=50)
    platform: Platform
    search_params: SearchParams
    results_limit: Optional[int] = Field(default=1000, ge=20, le=10000)

    model_config = {
        "from_attributes": True
    }

    @validator('platform')
    def validate_platform(cls, v):
        if isinstance(v, str):
            platform = Platform._missing_(v)
            if platform is None:
                raise ValueError('无效的平台类型')
            return platform
        return v

class SearchTaskUpdate(BaseModel):
    status: Optional[str] = None
    result_count: Optional[int] = None
    is_completed: Optional[bool] = None
    error_message: Optional[str] = None

    model_config = {
        "from_attributes": True
    }

class SearchTaskResponse(BaseModel):
    id: int
    name: str
    platform: Platform
    search_params: Dict
    status: str
    result_count: int
    results_limit: int
    is_completed: bool
    error_message: Optional[str]
    created_at: datetime
    completed_at: Optional[datetime]
    type: str = 'search'

    model_config = {
        "from_attributes": True,
        "json_encoders": {
            datetime: lambda v: v.isoformat()
        }
    } 