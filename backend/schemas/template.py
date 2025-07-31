from typing import Optional, List
from pydantic import BaseModel
from datetime import datetime

class TemplateBase(BaseModel):
    name: str
    content: str
    platform: str
    variables: Optional[List[str]] = None
    is_default: Optional[bool] = False
    is_active: Optional[bool] = True

    model_config = {
        "from_attributes": True,
        "json_schema_extra": {
            "example": {
                "name": "Example Template",
                "content": "Hello {name}!",
                "platform": "instagram",
                "variables": ["name"],
                "is_default": False,
                "is_active": True
            }
        }
    }

class TemplateCreate(TemplateBase):
    pass

class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None
    platform: Optional[str] = None
    variables: Optional[List[str]] = None
    is_default: Optional[bool] = None
    is_active: Optional[bool] = None

    model_config = {
        "from_attributes": True
    }

class TemplateResponse(TemplateBase):
    id: int
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    model_config = {
        "from_attributes": True,
        "json_encoders": {
            datetime: lambda v: v.isoformat()
        }
    } 