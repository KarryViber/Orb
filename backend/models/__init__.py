# 首先导入基础设施
from .database import Base, engine, get_db

# 然后导入枚举
from .enums import Platform, MessageStatus, TaskStatus

# 接着导入基础模型
from .template import MessageTemplate

# 最后导入依赖其他模型的模型
from .models import (
    User, 
    UserGroup, 
    UserGroupMember, 
    Message, 
    SearchTask, 
    MessageTask, 
    TaskMessage, 
    Activity,
    SystemConfig
)

__all__ = [
    # 基础设施
    'Base', 'engine', 'get_db',
    
    # 枚举
    'Platform', 'MessageStatus', 'TaskStatus',
    
    # 基础模型
    'MessageTemplate',
    
    # 其他模型
    'User', 'UserGroup', 'UserGroupMember',
    'Message', 'SearchTask', 'MessageTask',
    'TaskMessage', 'Activity', 'SystemConfig'
]
