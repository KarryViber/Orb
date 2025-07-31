import logging
import sys
import os
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# 加载环境变量
load_dotenv()

# 确保logs目录存在
if not os.path.exists('logs'):
    os.makedirs('logs')

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('logs/app.log'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)
logger.info("环境变量:")
logger.info(f"APIFY_API_TOKEN: {os.getenv('APIFY_API_TOKEN')}")
logger.info(f"APIFY_INSTAGRAM_ACTOR: {os.getenv('APIFY_INSTAGRAM_ACTOR')}")

# 确保数据库目录存在
db_path = os.path.dirname(os.getenv("DATABASE_URL", "sqlite:///./sns_web.db").replace("sqlite:///", ""))
if db_path and not os.path.exists(db_path):
    os.makedirs(db_path)

# 创建数据库表
from models import Base, engine
Base.metadata.create_all(bind=engine)

# 导入路由
from api import users, user_groups, messages, search_tasks, templates, proxy, dashboard, configs

app = FastAPI(
    title="SNS Web API",
    description="Social Network Service Web API",
    version="1.0.0"
)

# 配置CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源
    allow_credentials=False,  # 关闭 credentials
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# 注册路由
app.include_router(users.router, prefix="/api/users", tags=["users"])
app.include_router(user_groups.router, prefix="/api/user-groups", tags=["user_groups"])
app.include_router(messages.router, prefix="/api/messages", tags=["messages"])
app.include_router(search_tasks.router, prefix="/api/search-tasks", tags=["search_tasks"])
app.include_router(templates.router, prefix="/api/templates", tags=["templates"])
app.include_router(proxy.router, prefix="/api/proxy", tags=["proxy"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(configs.router, prefix="/api/configs", tags=["configs"])

@app.get("/health")
async def health_check():
    return {"status": "ok"}

# 错误处理
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Global error handler caught: {exc}", exc_info=True)
    response = JSONResponse(
        status_code=500,
        content={"detail": str(exc)}
    )
    # 添加 CORS 头部
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

if __name__ == "__main__":
    import uvicorn
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()

    logger.info(f"Starting server on port {args.port}")
    uvicorn.run("main:app", host="0.0.0.0", port=args.port, reload=True)