from models.database import SessionLocal, engine
from models.models import Base, User, MessageTemplate, MessageTask, Platform, TaskStatus
from datetime import datetime

def init_db():
    # 创建数据库表
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    try:
        # 检查是否已有数据
        if db.query(User).count() > 0:
            print("数据库已初始化，跳过")
            return
        
        # 创建测试用户
        test_users = [
            User(
                platform=Platform.INSTAGRAM,
                username="liza__51",
                display_name="Liza",
                profile_data={
                    'avatar_url': 'https://example.com/avatar1.jpg',
                    'followers_count': 1500,
                    'following_count': 800,
                    'post_count': 120,
                    'bio': 'Test user 1',
                    'is_verified': False,
                    'is_private': False
                }
            ),
            User(
                platform=Platform.INSTAGRAM,
                username="etingxu",
                display_name="Eting Xu",
                profile_data={
                    'avatar_url': 'https://example.com/avatar2.jpg',
                    'followers_count': 2000,
                    'following_count': 1000,
                    'post_count': 150,
                    'bio': 'Test user 2',
                    'is_verified': False,
                    'is_private': False
                }
            )
        ]
        
        for user in test_users:
            db.add(user)
        
        # 创建测试模板
        test_template = MessageTemplate(
            name="测试模板",
            content="你好 {username}，我是{sender_name}。",
            variables=["username", "sender_name"],
            platform=Platform.INSTAGRAM,
            is_default=True,
            created_by="system"
        )
        db.add(test_template)
        
        # 提交更改以获取ID
        db.commit()
        
        # 创建测试任务
        test_task = MessageTask(
            name="测试任务",
            description="这是一个测试任务",
            template_id=test_template.id,
            user_ids=[test_users[0].id],  # 使用第一个测试用户
            total_users=1,
            status=TaskStatus.PENDING,
            settings={
                "interval": 60,
                "daily_limit": 50
            }
        )
        db.add(test_task)
        
        # 最终提交
        db.commit()
        print("数据库初始化完成")
        
    except Exception as e:
        print(f"初始化数据库时出错: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    print("开始初始化数据库...")
    init_db() 