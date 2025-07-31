from typing import TypeVar, Generic, List, Any
from pydantic import BaseModel, ConfigDict
from datetime import datetime
from enum import Enum

T = TypeVar('T')

class BaseSchema(BaseModel):
    """基础模型类"""
    model_config = ConfigDict(
        from_attributes=True,
        populate_by_name=True,
        use_enum_values=True,
        validate_assignment=True,
        arbitrary_types_allowed=True,
        json_encoders={
            datetime: lambda v: v.isoformat() if v else None
        }
    )

    @classmethod
    def from_orm(cls, obj):
        """从 ORM 对象创建实例"""
        if hasattr(obj, '__dict__'):
            # 如果对象有__dict__属性，直接使用
            return cls.model_validate(obj)
        
        # 否则手动构建字典
        data = {}
        for field in cls.model_fields:
            if hasattr(obj, field):
                value = getattr(obj, field)
                # 处理枚举类型
                if isinstance(value, Enum):
                    data[field] = value.value
                else:
                    data[field] = value
        return cls.model_validate(data)

    def model_dump(self, **kwargs):
        """转换为字典"""
        exclude_none = kwargs.pop('exclude_none', True)
        by_alias = kwargs.pop('by_alias', True)
        
        data = super().model_dump(
            exclude_none=exclude_none,
            by_alias=by_alias,
            **kwargs
        )
        
        # 处理特殊类型
        for key, value in list(data.items()):
            if value is None and exclude_none:
                del data[key]
                continue
                
            if isinstance(value, datetime):
                data[key] = value.isoformat()
            elif isinstance(value, Enum):
                data[key] = value.value
            elif isinstance(value, list):
                data[key] = [
                    item.isoformat() if isinstance(item, datetime)
                    else item.value if isinstance(item, Enum)
                    else item.model_dump(**kwargs) if hasattr(item, 'model_dump')
                    else item
                    for item in value
                ]
            elif hasattr(value, 'model_dump'):
                data[key] = value.model_dump(**kwargs)
        
        return data

class PaginatedResponse(BaseSchema, Generic[T]):
    """分页响应基类"""
    items: List[T]
    total: int = 0
    page: int = 1
    page_size: int = 10

    def model_dump(self, **kwargs):
        """转换为字典"""
        data = super().model_dump(**kwargs)
        if isinstance(data.get('items'), list):
            data['items'] = [
                item.model_dump(**kwargs) if hasattr(item, 'model_dump') else item
                for item in data['items']
            ]
        return data 