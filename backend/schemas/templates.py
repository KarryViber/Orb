from typing import Optional, List
from datetime import datetime
from .common import BaseSchema
from pydantic import BaseModel

class TemplateBase(BaseSchema):
    """模板基础模型"""
    name: str
    content: str
    description: Optional[str] = None
    variables: Optional[List[str]] = None
    is_active: bool = True

class TemplateCreate(TemplateBase):
    """创建模板请求模型"""
    pass

class TemplateUpdate(BaseSchema):
    """更新模板请求模型"""
    name: Optional[str] = None
    content: Optional[str] = None
    description: Optional[str] = None
    variables: Optional[List[str]] = None
    is_active: Optional[bool] = None

class TemplateResponse(BaseModel):
    id: int
    name: str
    content: str
    variables: List[str]
    platform: str
    is_default: bool = False
    is_active: bool = True
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True 