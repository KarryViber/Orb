from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, ForeignKey, JSON, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from .database import Base
from .enums import Platform

class MessageTemplate(Base):
    """私信模板模型"""
    __tablename__ = 'message_templates'

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    content = Column(Text, nullable=False)
    platform = Column(Enum(Platform), nullable=False)
    variables = Column(JSON, nullable=True)
    is_default = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # 关系
    messages = relationship("Message", back_populates="template", lazy="dynamic")
    tasks = relationship("MessageTask", back_populates="template", lazy="dynamic") 