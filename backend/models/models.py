from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, JSON, Enum, Text, Boolean, Float, Index, ARRAY, Table
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from datetime import datetime
from .database import Base
from .enums import Platform, MessageStatus, TaskStatus
from .template import MessageTemplate  # 导入 MessageTemplate，而不是重新定义
import json

# 搜索任务用户关联表
search_task_users = Table(
    "search_task_users",
    Base.metadata,
    Column("search_task_id", Integer, ForeignKey("search_tasks.id"), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id"), primary_key=True),
    Column("created_at", DateTime, default=datetime.utcnow)
)

class User(Base):
    """用户模型"""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    platform = Column(Enum(Platform), nullable=False)
    username = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    profile_data = Column(JSON, nullable=True, default=dict)
    tags = Column(JSON, nullable=True, default=list)
    contacted = Column(Boolean, nullable=False, default=False, index=True)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # 关系
    messages = relationship("Message", back_populates="user")
    groups = relationship("UserGroup", secondary="user_group_members", back_populates="users")
    search_tasks = relationship(
        "SearchTask",
        secondary=search_task_users,
        back_populates="users",
        overlaps="users"
    )

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if 'profile_data' not in kwargs:
            self.profile_data = {
                'avatar_url': None,
                'followers_count': 0,
                'following_count': 0,
                'post_count': 0,
                'bio': None,
                'is_verified': False,
                'is_private': False,
                'website': None,
                'category': None,
                'profile_url': None
            }
        if 'tags' not in kwargs:
            self.tags = []

class UserGroup(Base):
    """用户组模型"""
    __tablename__ = "user_groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    platform = Column(Enum(Platform), nullable=False)
    created_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # 关系
    users = relationship("User", secondary="user_group_members", back_populates="groups")

class UserGroupMember(Base):
    """用户组成员关联表"""
    __tablename__ = "user_group_members"

    group_id = Column(Integer, ForeignKey("user_groups.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_group_member', 'group_id', 'user_id'),
    )

class Message(Base):
    """私信记录模型"""
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    template_id = Column(Integer, ForeignKey("message_templates.id"))
    content = Column(Text)  # 实际发送的内容
    status = Column(Enum(MessageStatus), default=MessageStatus.PENDING)
    sent_at = Column(DateTime)
    delivered_at = Column(DateTime)
    error_message = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # 关系
    user = relationship("User", back_populates="messages")
    template = relationship("MessageTemplate", back_populates="messages")

class SearchTask(Base):
    """搜索任务模型"""
    __tablename__ = "search_tasks"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    platform = Column(Enum(Platform), nullable=False)
    search_params = Column(JSON, nullable=False, default=dict)
    status = Column(String(50), nullable=False, default="pending")
    result_count = Column(Integer, nullable=False, default=0)
    results_limit = Column(Integer, nullable=False, default=1000)
    is_completed = Column(Boolean, nullable=False, default=False)
    error_message = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True))
    type = Column(String(50), nullable=False, default="search")

    # 修改关系配置，添加 back_populates
    users = relationship(
        "User",
        secondary=search_task_users,
        back_populates="search_tasks",
        overlaps="search_tasks"
    )

    def to_dict(self):
        """转换为字典"""
        return {
            'id': self.id,
            'name': self.name,
            'platform': self.platform.value if self.platform else None,
            'search_params': json.loads(self.search_params) if isinstance(self.search_params, str) else self.search_params,
            'status': self.status,
            'result_count': self.result_count,
            'results_limit': self.results_limit,
            'is_completed': self.is_completed,
            'error_message': self.error_message,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'completed_at': self.completed_at.isoformat() if self.completed_at else None,
            'type': self.type
        }

class SearchResult(Base):
    """搜索结果模型"""
    __tablename__ = "search_results"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("search_tasks.id", ondelete="CASCADE"), nullable=False)
    platform = Column(Enum(Platform), nullable=False)
    platform_id = Column(String(255), nullable=False)
    username = Column(String(255))
    full_name = Column(String(255))
    bio = Column(Text)
    website = Column(String(255))
    followers_count = Column(Integer)
    following_count = Column(Integer)
    posts_count = Column(Integer)
    is_verified = Column(Boolean)
    is_private = Column(Boolean)
    avatar_url = Column(String(255))
    category = Column(String(255))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    raw_data = Column(JSON)

    task = relationship("SearchTask", backref="results")

    def to_dict(self):
        """转换为字典"""
        return {
            'id': self.id,
            'task_id': self.task_id,
            'platform': self.platform.value if self.platform else None,
            'platform_id': self.platform_id,
            'username': self.username,
            'full_name': self.full_name,
            'bio': self.bio,
            'website': self.website,
            'followers_count': self.followers_count,
            'following_count': self.following_count,
            'posts_count': self.posts_count,
            'is_verified': self.is_verified,
            'is_private': self.is_private,
            'avatar_url': self.avatar_url,
            'category': self.category,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'raw_data': self.raw_data
        }

class MessageTask(Base):
    """消息任务模型"""
    __tablename__ = "message_tasks"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    template_id = Column(Integer, ForeignKey("message_templates.id"))
    user_ids = Column(JSON, nullable=True)  # 存储用户ID列表
    group_ids = Column(JSON, nullable=True)  # 存储用户组ID列表
    total_users = Column(Integer, default=0)
    success_count = Column(Integer, default=0)
    failed_count = Column(Integer, default=0)
    status = Column(Enum(TaskStatus), default=TaskStatus.PENDING)
    progress = Column(Float, default=0)
    speed = Column(Float, nullable=True)
    settings = Column(JSON, nullable=True)
    variables = Column(JSON, nullable=True)  # 存储变量映射
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    stopped_at = Column(DateTime, nullable=True)

    # 关系
    template = relationship("MessageTemplate", back_populates="tasks")
    messages = relationship("Message", secondary="task_messages")

class TaskMessage(Base):
    """任务-消息关联表"""
    __tablename__ = "task_messages"

    task_id = Column(Integer, ForeignKey("message_tasks.id", ondelete="CASCADE"), primary_key=True)
    message_id = Column(Integer, ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index('idx_task_message', 'task_id', 'message_id'),
    )

class Activity(Base):
    """活动记录模型"""
    __tablename__ = "activities"

    id = Column(Integer, primary_key=True, index=True)
    type = Column(String, nullable=False)  # success, warning, info, error
    content = Column(Text, nullable=False)
    time = Column(DateTime, default=datetime.utcnow)
    related_id = Column(Integer, nullable=True)  # 关联ID（如任务ID、用户ID等）
    related_type = Column(String, nullable=True)  # 关联类型（如task, user, message等）
    created_at = Column(DateTime, default=datetime.utcnow)

    @classmethod
    def create_activity(cls, db, type, content, related_id=None, related_type=None):
        """创建活动记录的便捷方法"""
        activity = cls(
            type=type,
            content=content,
            related_id=related_id,
            related_type=related_type
        )
        db.add(activity)
        db.commit()
        return activity

class SystemConfig(Base):
    """系统配置模型"""
    __tablename__ = "system_configs"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, unique=True, nullable=False)
    value = Column(Text, nullable=True)
    description = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if 'value' not in kwargs:
            self.value = None