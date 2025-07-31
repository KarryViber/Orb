from sqlalchemy import create_engine, text
import os

# 获取数据库URL
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./sns_web.db")

# 创建数据库引擎
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
)

def add_created_by_column():
    with engine.connect() as conn:
        # 检查列是否已存在
        result = conn.execute(text("PRAGMA table_info(users)"))
        columns = [row[1] for row in result.fetchall()]
        
        if 'created_by' not in columns:
            # 添加created_by列
            conn.execute(text("ALTER TABLE users ADD COLUMN created_by VARCHAR"))
            print("成功添加created_by列到users表")
        else:
            print("created_by列已存在")

if __name__ == "__main__":
    add_created_by_column()
