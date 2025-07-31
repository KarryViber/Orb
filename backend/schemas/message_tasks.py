from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import field_validator, model_validator
from .common import BaseSchema
from .templates import TemplateResponse

class MessageTaskSettings(BaseSchema):
    interval: int = 60  # 发送间隔（分钟）
    daily_limit: int = 50  # 每日发送限制

    model_config = {
        "json_schema_extra": {
            "example": {
                "interval": 60,
                "daily_limit": 50
            }
        }
    }

class MessageTaskCreate(BaseSchema):
    name: str
    template_id: int
    user_ids: Optional[List[int]] = None
    group_ids: Optional[List[int]] = None
    settings: MessageTaskSettings

    @model_validator(mode='after')
    def validate_target_users(self) -> 'MessageTaskCreate':
        if not any([self.user_ids, self.group_ids]):
            raise ValueError("必须指定目标用户或用户组")
        return self

class MessageTaskResponse(BaseSchema):
    id: int
    name: str
    template: TemplateResponse
    total_users: int
    success_count: int = 0
    failed_count: int = 0
    status: str = "pending"
    progress: float = 0
    speed: Optional[float] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None

    class Config:
        from_attributes = True

    @classmethod
    def from_orm(cls, obj):
        """从 ORM 对象创建实例"""
        data = {
            'id': getattr(obj, 'id', None),
            'name': getattr(obj, 'name', None),
            'template': getattr(obj, 'template', None),
            'total_users': getattr(obj, 'total_users', 0),
            'success_count': getattr(obj, 'success_count', 0),
            'failed_count': getattr(obj, 'failed_count', 0),
            'status': getattr(obj, 'status', 'pending'),
            'progress': getattr(obj, 'progress', 0),
            'speed': getattr(obj, 'speed', None),
            'created_at': getattr(obj, 'created_at', None),
            'updated_at': getattr(obj, 'updated_at', None),
            'started_at': getattr(obj, 'started_at', None),
            'completed_at': getattr(obj, 'completed_at', None)
        }

        if data['template']:
            if isinstance(data['template'], dict):
                data['template'] = TemplateResponse.model_validate(data['template'])
            else:
                data['template'] = TemplateResponse.from_orm(data['template'])

        return cls.model_validate(data) 