from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, JSON, Enum, Boolean
from sqlalchemy.orm import Mapped

from ..database import Base
from ..schemas.common import Platform

class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = Column(Integer, primary_key=True, index=True)
    username: Mapped[str] = Column(String(50), index=True)
    display_name: Mapped[str] = Column(String(100))
    platform: Mapped[Platform] = Column(Enum(Platform))
    tags: Mapped[list[str]] = Column(JSON, default=list)
    profile_data: Mapped[dict] = Column(JSON, default=dict)
    contacted: Mapped[bool] = Column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = Column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by: Mapped[str] = Column(String(50), nullable=True) 