from enum import Enum

class Platform(str, Enum):
    """社交平台枚举"""
    INSTAGRAM = "instagram"
    FACEBOOK = "facebook"
    TWITTER = "twitter"
    TIKTOK = "tiktok"
    YOUTUBE = "youtube"
    LINKEDIN = "linkedin"

    def __str__(self):
        return self.value

    @classmethod
    def _missing_(cls, value):
        """处理未知的平台类型"""
        if isinstance(value, str):
            value = value.lower()
            for member in cls:
                if member.value.lower() == value:
                    return member
        return None

class MessageStatus(str, Enum):
    """私信状态枚举"""
    PENDING = "pending"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"

    @classmethod
    def _missing_(cls, value):
        """处理未知的消息状态"""
        return None

class TaskStatus(str, Enum):
    """任务状态枚举"""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    STOPPED = "stopped"

    @classmethod
    def _missing_(cls, value):
        """处理未知的任务状态"""
        return None 