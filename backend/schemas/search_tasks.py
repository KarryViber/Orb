from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import field_validator, model_validator
from .common import BaseSchema
from models.models import Platform
import json
import logging

logger = logging.getLogger(__name__)

class SearchParams(BaseSchema):
    """搜索参数模型"""
    keywords: Optional[List[str]] = None
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
    # Twitter特有参数
    language: Optional[str] = None  # 推文语言
    min_retweets: Optional[int] = None  # 最小转发数
    min_likes: Optional[int] = None  # 最小点赞数
    min_replies: Optional[int] = None  # 最小回复数
    start_date: Optional[datetime] = None  # 开始日期
    end_date: Optional[datetime] = None  # 结束日期

    @field_validator('min_followers', 'max_followers', 'min_following', 'max_following', 'min_posts', 'max_posts', 'min_retweets', 'min_likes', 'min_replies')
    @classmethod
    def validate_range(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < 0:
            raise ValueError("Value must be greater than or equal to 0")
        return v

    @field_validator('language')
    @classmethod
    def validate_language(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            # 转换为小写
            v = v.lower()
            # 检查是否是有效的语言代码（这里可以添加更多语言代码的验证）
            valid_languages = {'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh'}
            if v not in valid_languages:
                raise ValueError(f"Invalid language code. Must be one of: {', '.join(valid_languages)}")
        return v

    @model_validator(mode='after')
    def validate_dates(self) -> 'SearchParams':
        if self.start_date and self.end_date and self.start_date > self.end_date:
            raise ValueError("start_date must be before end_date")
        return self

class SearchTaskCreate(BaseSchema):
    """创建搜索任务请求模型"""
    name: str
    platform: Platform
    search_params: SearchParams
    results_limit: Optional[int] = None

    @field_validator('results_limit')
    @classmethod
    def validate_results_limit(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < 1:
            raise ValueError("results_limit must be greater than 0")
        return v

class SearchTaskResponse(BaseSchema):
    """搜索任务响应模型"""
    id: int
    name: str
    platform: Platform
    search_params: dict
    status: str
    result_count: int
    results_limit: int
    is_completed: bool
    error_message: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime] = None
    type: str = 'search'

    @classmethod
    def from_orm(cls, obj):
        """从 ORM 对象创建实例"""
        try:
            data = {
                'id': getattr(obj, 'id', None),
                'name': getattr(obj, 'name', None),
                'platform': getattr(obj, 'platform', None),
                'search_params': getattr(obj, 'search_params', {}),
                'status': getattr(obj, 'status', 'pending'),
                'result_count': getattr(obj, 'result_count', 0),
                'results_limit': getattr(obj, 'results_limit', 1000),
                'is_completed': getattr(obj, 'is_completed', False),
                'error_message': getattr(obj, 'error_message', None),
                'created_at': getattr(obj, 'created_at', None),
                'completed_at': getattr(obj, 'completed_at', None),
                'type': getattr(obj, 'type', 'search')
            }

            # 确保 search_params 是字典
            if not isinstance(data['search_params'], dict):
                try:
                    if isinstance(data['search_params'], str):
                        data['search_params'] = json.loads(data['search_params'])
                    else:
                        data['search_params'] = {}
                except:
                    data['search_params'] = {}

            # 处理平台枚举
            if isinstance(data['platform'], Platform):
                data['platform'] = data['platform'].value

            return cls.model_validate(data)
        except Exception as e:
            logger.error(f"Error in from_orm: {str(e)}")
            raise

    def model_dump(self, **kwargs):
        """转换为字典"""
        data = super().model_dump(**kwargs)
        # 处理平台枚举
        if isinstance(data.get('platform'), Platform):
            data['platform'] = data['platform'].value
        # 处理日期时间
        if data.get('created_at') and isinstance(data['created_at'], datetime):
            data['created_at'] = data['created_at'].isoformat()
        if data.get('completed_at') and isinstance(data['completed_at'], datetime):
            data['completed_at'] = data['completed_at'].isoformat()
        return data

class SearchTaskListResponse(BaseSchema):
    """搜索任务列表响应模型"""
    data: List[SearchTaskResponse]
    total: int = 0
    page: int = 1
    page_size: int = 10

    @classmethod
    def from_orm(cls, obj):
        """从 ORM 对象创建实例"""
        if isinstance(obj, dict):
            # 确保data是列表
            data = obj.get('data', [])
            if not isinstance(data, list):
                data = [data] if data is not None else []

            # 确保每个元素都是SearchTaskResponse对象
            validated_data = []
            for item in data:
                try:
                    if isinstance(item, dict):
                        validated_data.append(SearchTaskResponse.model_validate(item))
                    else:
                        validated_data.append(SearchTaskResponse.from_orm(item))
                except Exception as e:
                    logger.error(f"验证搜索任务数据失败: {str(e)}")
                    continue

            return cls.model_validate({
                'data': validated_data,
                'total': obj.get('total', len(validated_data)),
                'page': obj.get('page', 1),
                'page_size': obj.get('page_size', 10)
            })
        return super().from_orm(obj)

    def model_dump(self, **kwargs):
        """转换为字典"""
        data = super().model_dump(**kwargs)
        if isinstance(data.get('data'), list):
            data['data'] = [
                task.model_dump(**kwargs) if hasattr(task, 'model_dump')
                else task
                for task in data['data']
            ]
        return data

class SearchTaskUpdate(BaseSchema):
    """更新搜索任务请求模型"""
    status: Optional[str] = None
    result_count: Optional[int] = None
    is_completed: Optional[bool] = None
    error_message: Optional[str] = None

    @field_validator('result_count')
    @classmethod
    def validate_result_count(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and v < 0:
            raise ValueError("result_count must be greater than or equal to 0")
        return v

class DashboardStats(BaseSchema):
    """仪表盘统计数据响应模型"""
    totalUsers: int
    activeUsers: int
    totalMessages: int
    deliveredMessages: int
    totalTemplates: int
    activeTemplates: int
    totalTasks: int
    runningTasks: int

class ActivityResponse(BaseSchema):
    """活动记录响应模型"""
    id: int
    time: datetime
    type: str
    content: str 