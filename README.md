# SNS Web 搜索消息系统

## 项目简介

这是一个专为社交媒体营销和客户开发设计的智能化管理平台。系统帮助企业和营销人员高效地在各大社交平台上发现潜在客户，并通过自动化的消息发送功能实现精准营销。

### 核心业务价值

🎯 **精准客户发现** - 通过多维度搜索条件，快速定位目标用户群体，提高营销效率

📧 **自动化消息营销** - 支持批量消息发送和模板化管理，大幅降低人工成本

👥 **客户关系管理** - 完整的用户信息管理和分组功能，便于精细化运营

📊 **数据驱动决策** - 提供详细的搜索结果分析和发送效果统计，优化营销策略

### 适用场景

- **电商营销**: 寻找潜在买家，推广产品和服务
- **B2B销售**: 发现企业决策者，建立商业联系
- **品牌推广**: 找到意见领袖和目标受众，扩大品牌影响力
- **市场调研**: 收集用户反馈，了解市场趋势
- **客户服务**: 主动联系客户，提供个性化服务

## 技术栈

### 前端技术栈
- **Vue 3** - 渐进式JavaScript框架 (Composition API)
- **TypeScript** - 类型安全的JavaScript超集
- **Element Plus** - 基于Vue 3的组件库
- **Vue Router 4** - Vue.js官方路由管理器
- **Pinia** - Vue的状态管理库
- **Vite** - 下一代前端构建工具
- **Vue I18n** - Vue.js国际化插件
- **Axios** - HTTP客户端库
- **@vueuse/core** - Vue组合式API工具集

### 后端技术栈
- **FastAPI** - 现代、快速的Web框架
- **SQLAlchemy** - Python SQL工具包和ORM
- **SQLite** - 轻量级数据库
- **Pydantic** - 数据验证和设置管理
- **Uvicorn** - ASGI服务器
- **Alembic** - 数据库迁移工具
- **Celery** - 分布式任务队列
- **Beautiful Soup** - HTML/XML解析库
- **Apify Client** - 网络爬虫平台客户端

### 部署技术栈
- **Docker** - 容器化部署
- **Nginx** - 反向代理和静态文件服务
- **Docker Compose** - 多容器应用编排

## 主要功能模块

### 1. 用户管理系统
- **用户信息管理**: 创建、编辑、删除、查询用户信息
- **用户组管理**: 用户分组和权限管理
- **批量操作**: 支持批量导入和操作用户数据
- **用户状态管理**: 用户激活、禁用等状态控制

### 2. 消息系统
- **消息模板管理**: 创建、编辑、删除消息模板
- **消息任务管理**: 创建和执行消息发送任务
- **发送记录追踪**: 查看消息发送历史和状态
- **模板变量支持**: 支持动态变量替换

### 3. 搜索功能
- **搜索任务管理**: 创建、配置、执行搜索任务
- **搜索结果展示**: 多维度展示搜索结果
- **数据导出功能**: 支持搜索结果数据导出
- **搜索历史记录**: 保存和查看搜索历史

### 4. 系统配置
- **系统参数配置**: 基础系统设置和参数管理
- **代理设置管理**: 网络代理配置和管理
- **仪表盘统计**: 系统运行状态和数据统计
- **配置备份恢复**: 系统配置的备份和恢复

## 项目结构

```
SNS_web_corsur_X搜索功能实现版本/
├── frontend/                    # 前端项目目录
│   ├── src/
│   │   ├── views/              # 页面组件 (17个视图)
│   │   │   ├── HomeView.vue    # 首页
│   │   │   ├── UserView.vue    # 用户管理
│   │   │   ├── MessageView.vue # 消息管理
│   │   │   ├── SearchResultView.vue # 搜索结果
│   │   │   └── ...
│   │   ├── components/         # 通用组件 (8个组件)
│   │   ├── api/               # API接口定义 (9个模块)
│   │   ├── stores/            # Pinia状态管理 (3个store)
│   │   ├── router/            # 路由配置
│   │   ├── types/             # TypeScript类型定义 (9个类型文件)
│   │   ├── utils/             # 工具函数 (6个工具模块)
│   │   ├── services/          # 业务服务 (6个服务)
│   │   ├── hooks/             # Vue组合式函数 (2个hook)
│   │   └── i18n/              # 国际化配置
│   ├── public/                # 静态资源
│   ├── package.json           # 前端依赖配置
│   ├── vite.config.ts         # Vite构建配置
│   ├── tsconfig.json          # TypeScript配置
│   └── Dockerfile             # 前端Docker配置
├── backend/                    # 后端项目目录
│   ├── api/                   # API路由模块 (12个路由文件)
│   │   ├── users.py           # 用户相关API
│   │   ├── messages.py        # 消息相关API
│   │   ├── search_tasks.py    # 搜索任务API
│   │   ├── templates.py       # 模板管理API
│   │   └── ...
│   ├── models/                # 数据模型 (21个模型)
│   ├── schemas/               # Pydantic模式 (27个模式)
│   ├── services/              # 业务逻辑服务 (8个服务)
│   ├── utils/                 # 工具函数
│   ├── alembic/               # 数据库迁移
│   ├── main.py                # FastAPI应用入口
│   ├── requirements.txt       # Python依赖
│   ├── init_db.py            # 数据库初始化脚本
│   └── Dockerfile            # 后端Docker配置
├── docker-compose.yml         # Docker编排配置
├── nginx.conf                 # Nginx反向代理配置
├── deploy.sh                  # 自动化部署脚本
├── API_PORTS.md              # API端口配置说明
└── README.md                 # 项目说明文档
```

## 快速开始

### 环境要求

- **Node.js** 18.0+ 
- **Python** 3.8+
- **npm** 或 **yarn**
- **Git**

### 本地开发环境搭建

#### 1. 克隆项目
```bash
git clone <repository-url>
cd SNS_web_corsur_X搜索功能实现版本
```

#### 2. 后端服务启动
```bash
cd backend

# 创建Python虚拟环境（推荐）
python -m venv venv

# 激活虚拟环境
# macOS/Linux:
source venv/bin/activate
# Windows:
venv\Scripts\activate

# 安装Python依赖
pip install -r requirements.txt

# 初始化数据库
python init_db.py

# 启动后端服务
python main.py --port 8081
# 或使用uvicorn
uvicorn main:app --reload --host 0.0.0.0 --port 8081
```

#### 3. 前端服务启动
```bash
cd frontend

# 安装Node.js依赖
npm install

# 启动前端开发服务器
npm run dev
```

#### 4. 访问应用
- **前端应用**: http://localhost:5173
- **后端API文档**: http://localhost:8081/docs
- **健康检查**: http://localhost:8081/health

### Docker容器化部署

#### 1. 构建Docker镜像
```bash
# 构建前端镜像
cd frontend
docker build -t sns-web-frontend .

# 构建后端镜像
cd ../backend
docker build -t sns-web-backend .
```

#### 2. 使用Docker Compose启动
```bash
# 返回项目根目录
cd ..

# 启动所有服务
docker-compose up -d

# 查看服务状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

#### 3. 访问容器化应用
- **应用地址**: http://localhost:8000

### 生产环境部署

使用提供的自动化部署脚本：
```bash
# 赋予执行权限
chmod +x deploy.sh

# 执行部署
./deploy.sh
```

## 配置说明

### 环境变量配置

#### 后端环境变量 (backend/.env)
```env
# 数据库配置
DATABASE_URL=sqlite:///./sns_web.db

# Apify爬虫配置
APIFY_API_TOKEN=your_apify_api_token
APIFY_INSTAGRAM_ACTOR=your_instagram_actor_id

# 其他配置
ENV=development
DB_PRESERVE_DATA=true
```

#### 前端环境变量 (frontend/.env)
```env
# API基础URL
VITE_API_BASE_URL=http://localhost:8081
```

### 端口配置详情

| 服务 | 开发环境端口 | 生产环境端口 | 说明 |
|------|-------------|-------------|------|
| 前端开发服务器 | 5173 | - | Vite开发服务器 |
| 后端API服务器 | 8081 | 8081 | FastAPI应用服务器 |
| Nginx反向代理 | - | 8000 | 生产环境统一入口 |

详细配置请参考: [API_PORTS.md](./API_PORTS.md)

## API接口文档

### 主要API端点

| 模块 | API路径 | 功能描述 |
|------|---------|----------|
| 用户管理 | `/api/users` | 用户CRUD操作 |
| 用户组管理 | `/api/user-groups` | 用户组管理 |
| 消息管理 | `/api/messages` | 消息和消息任务管理 |
| 搜索任务 | `/api/search-tasks` | 搜索任务CRUD |
| 模板管理 | `/api/templates` | 消息模板管理 |
| 代理设置 | `/api/proxy` | 网络代理配置 |
| 仪表盘 | `/api/dashboard` | 统计数据获取 |
| 系统配置 | `/api/configs` | 系统参数配置 |

### API文档访问

启动后端服务后，可通过以下地址访问完整的API文档：
- **Swagger UI**: http://localhost:8081/docs
- **ReDoc**: http://localhost:8081/redoc

## 故障排除

### 常见问题

1. **端口占用**
   ```bash
   # 检查端口占用
   lsof -i :5173  # 前端端口
   lsof -i :8081  # 后端端口
   
   # 杀死占用进程
   kill -9 <PID>
   ```

2. **数据库问题**
   ```bash
   # 重新初始化数据库
   cd backend
   python init_db.py
   ```

3. **依赖问题**
   ```bash
   # 前端依赖问题
   cd frontend
   rm -rf node_modules package-lock.json
   npm install
   
   # 后端依赖问题
   cd backend
   pip install -r requirements.txt --force-reinstall
   ```

### 日志查看

- 前端日志: 浏览器开发者工具控制台
- 后端日志: `backend/logs/app.log`
- Nginx日志: `/data/karry/sns-web/logs/nginx/`

## 开发指南

### 前端开发规范

1. **使用 Vue 3 Composition API**
2. **遵循 TypeScript 类型约束**
3. **使用 Element Plus 组件库**
4. **统一使用 Pinia 进行状态管理**
5. **API 接口统一使用 axios**

### 后端开发规范

1. **使用 FastAPI 框架**
2. **遵循 RESTful API 设计**
3. **使用 Pydantic 数据验证**
4. **使用 SQLAlchemy ORM**
5. **业务逻辑封装在 services 层**

## 更新日志

### v1.0.0 (当前版本)
- ✅ 完整的用户管理系统
- ✅ 消息模板和任务管理
- ✅ 搜索功能实现
- ✅ 系统配置和仪表盘
- ✅ Docker 容器化部署
- ✅ 完整的 API 文档

## 技术支持

如果您在使用过程中遇到问题，请：

1. 查看本文档的故障排除部分
2. 检查 [API_PORTS.md](./API_PORTS.md) 配置说明
3. 查看项目 Issues
4. 联系开发团队

---