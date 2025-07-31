# SNS Web Search & Messaging System

**Language:** [English](./README.md) | [中文](./README.zh.md) | [日本語](./README.ja.md)

---

## Project Overview

This is an intelligent management platform designed specifically for social media marketing and customer development. The system helps businesses and marketers efficiently discover potential customers across major social platforms and achieve precision marketing through automated messaging features.

### Core Business Value

🎯 **Precise Customer Discovery** - Quickly locate target user groups through multi-dimensional search criteria, improving marketing efficiency

📧 **Automated Message Marketing** - Support batch message sending and template management, significantly reducing labor costs

👥 **Customer Relationship Management** - Complete user information management and grouping functions for refined operations

📊 **Data-Driven Decision Making** - Provide detailed search result analysis and sending effectiveness statistics to optimize marketing strategies


<img width="3360" height="1720" alt="CleanShot 2025-07-31 at 16 25 03@2x" src="https://github.com/user-attachments/assets/1a131a5a-80f1-4c9d-a5d4-f39ec30228da" />
<img width="3386" height="1744" alt="CleanShot 2025-07-31 at 16 25 31@2x" src="https://github.com/user-attachments/assets/3a0ac797-8a49-4bee-84a4-657e76afb640" />
<img width="3398" height="1736" alt="CleanShot 2025-07-31 at 16 25 46@2x" src="https://github.com/user-attachments/assets/3e74e7dc-7751-490f-94b2-6fec35aa6b03" />


### Use Cases

- **E-commerce Marketing**: Find potential buyers, promote products and services
- **B2B Sales**: Discover enterprise decision-makers, establish business connections
- **Brand Promotion**: Find opinion leaders and target audiences, expand brand influence
- **Market Research**: Collect user feedback, understand market trends
- **Customer Service**: Proactively contact customers, provide personalized services

## Technology Stack

### Frontend Technologies
- **Vue 3** - Progressive JavaScript framework (Composition API)
- **TypeScript** - Type-safe JavaScript superset
- **Element Plus** - Vue 3-based component library
- **Vue Router 4** - Official Vue.js routing manager
- **Pinia** - Vue state management library
- **Vite** - Next-generation frontend build tool
- **Vue I18n** - Vue.js internationalization plugin
- **Axios** - HTTP client library
- **@vueuse/core** - Vue composition API utilities

### Backend Technologies
- **FastAPI** - Modern, fast web framework
- **SQLAlchemy** - Python SQL toolkit and ORM
- **SQLite** - Lightweight database
- **Pydantic** - Data validation and settings management
- **Uvicorn** - ASGI server
- **Alembic** - Database migration tool
- **Celery** - Distributed task queue
- **Beautiful Soup** - HTML/XML parsing library
- **Apify Client** - Web scraping platform client

### Deployment Technologies
- **Docker** - Containerized deployment
- **Nginx** - Reverse proxy and static file service
- **Docker Compose** - Multi-container application orchestration

## Key Functional Modules

### 1. User Management System
- **User Information Management**: Create, edit, delete, query user information
- **User Group Management**: User grouping and permission management
- **Batch Operations**: Support batch import and user data operations
- **User Status Management**: User activation, deactivation and other status controls

### 2. Messaging System
- **Message Template Management**: Create, edit, delete message templates
- **Message Task Management**: Create and execute message sending tasks
- **Sending Record Tracking**: View message sending history and status
- **Template Variable Support**: Support dynamic variable replacement

### 3. Search Functionality
- **Search Task Management**: Create, configure, execute search tasks
- **Search Result Display**: Multi-dimensional search result presentation
- **Data Export Function**: Support search result data export
- **Search History Records**: Save and view search history

### 4. System Configuration
- **System Parameter Configuration**: Basic system settings and parameter management
- **Proxy Settings Management**: Network proxy configuration and management
- **Dashboard Statistics**: System operation status and data statistics
- **Configuration Backup & Recovery**: System configuration backup and recovery

## Project Structure

```
SNS_web_corsur_X搜索功能实现版本/
├── frontend/                    # Frontend project directory
│   ├── src/
│   │   ├── views/              # Page components (17 views)
│   │   │   ├── HomeView.vue    # Homepage
│   │   │   ├── UserView.vue    # User management
│   │   │   ├── MessageView.vue # Message management
│   │   │   ├── SearchResultView.vue # Search results
│   │   │   └── ...
│   │   ├── components/         # Common components (8 components)
│   │   ├── api/               # API interface definitions (9 modules)
│   │   ├── stores/            # Pinia state management (3 stores)
│   │   ├── router/            # Route configuration
│   │   ├── types/             # TypeScript type definitions (9 type files)
│   │   ├── utils/             # Utility functions (6 utility modules)
│   │   ├── services/          # Business services (6 services)
│   │   ├── hooks/             # Vue composition functions (2 hooks)
│   │   └── i18n/              # Internationalization configuration
│   ├── public/                # Static resources
│   ├── package.json           # Frontend dependency configuration
│   ├── vite.config.ts         # Vite build configuration
│   ├── tsconfig.json          # TypeScript configuration
│   └── Dockerfile             # Frontend Docker configuration
├── backend/                    # Backend project directory
│   ├── api/                   # API route modules (12 route files)
│   │   ├── users.py           # User-related APIs
│   │   ├── messages.py        # Message-related APIs
│   │   ├── search_tasks.py    # Search task APIs
│   │   ├── templates.py       # Template management APIs
│   │   └── ...
│   ├── models/                # Data models (21 models)
│   ├── schemas/               # Pydantic schemas (27 schemas)
│   ├── services/              # Business logic services (8 services)
│   ├── utils/                 # Utility functions
│   ├── alembic/               # Database migrations
│   ├── main.py                # FastAPI application entry
│   ├── requirements.txt       # Python dependencies
│   ├── init_db.py            # Database initialization script
│   └── Dockerfile            # Backend Docker configuration
├── docker-compose.yml         # Docker orchestration configuration
├── nginx.conf                 # Nginx reverse proxy configuration
├── deploy.sh                  # Automated deployment script
├── API_PORTS.md              # API port configuration documentation
└── README.md                 # Project documentation
```

## Quick Start

### Environment Requirements

- **Node.js** 18.0+
- **Python** 3.8+
- **npm** or **yarn**
- **Git**

### Local Development Environment Setup

#### 1. Clone Project
```bash
git clone <repository-url>
cd SNS_web_corsur_X搜索功能实现版本
```

#### 2. Backend Service Startup
```bash
cd backend

# Create Python virtual environment (recommended)
python -m venv venv

# Activate virtual environment
# macOS/Linux:
source venv/bin/activate
# Windows:
venv\Scripts\activate

# Install Python dependencies
pip install -r requirements.txt

# Initialize database
python init_db.py

# Start backend service
python main.py --port 8081
# Or use uvicorn
uvicorn main:app --reload --host 0.0.0.0 --port 8081
```

#### 3. Frontend Service Startup
```bash
cd frontend

# Install Node.js dependencies
npm install

# Start frontend development server
npm run dev
```

#### 4. Access Application
- **Frontend Application**: http://localhost:5173
- **Backend API Documentation**: http://localhost:8081/docs
- **Health Check**: http://localhost:8081/health

### Docker Containerized Deployment

#### 1. Build Docker Images
```bash
# Build frontend image
cd frontend
docker build -t sns-web-frontend .

# Build backend image
cd ../backend
docker build -t sns-web-backend .
```

#### 2. Start with Docker Compose
```bash
# Return to project root directory
cd ..

# Start all services
docker-compose up -d

# Check service status
docker-compose ps

# View logs
docker-compose logs -f
```

#### 3. Access Containerized Application
- **Application Address**: http://localhost:8000

### Production Environment Deployment

Use the provided automated deployment script:
```bash
# Grant execution permissions
chmod +x deploy.sh

# Execute deployment
./deploy.sh
```

## Configuration

### Environment Variable Configuration

#### Backend Environment Variables (backend/.env)
```env
# Database configuration
DATABASE_URL=sqlite:///./sns_web.db

# Apify scraping configuration
APIFY_API_TOKEN=your_apify_api_token
APIFY_INSTAGRAM_ACTOR=your_instagram_actor_id

# Other configurations
ENV=development
DB_PRESERVE_DATA=true
```

#### Frontend Environment Variables (frontend/.env)
```env
# API base URL
VITE_API_BASE_URL=http://localhost:8081
```

### Port Configuration Details

| Service | Development Port | Production Port | Description |
|---------|------------------|-----------------|-------------|
| Frontend Dev Server | 5173 | - | Vite development server |
| Backend API Server | 8081 | 8081 | FastAPI application server |
| Nginx Reverse Proxy | - | 8000 | Production environment unified entry |

For detailed configuration, please refer to: [API_PORTS.md](./API_PORTS.md)

## API Documentation

### Main API Endpoints

| Module | API Path | Function Description |
|--------|----------|---------------------|
| User Management | `/api/users` | User CRUD operations |
| User Group Management | `/api/user-groups` | User group management |
| Message Management | `/api/messages` | Message and message task management |
| Search Tasks | `/api/search-tasks` | Search task CRUD |
| Template Management | `/api/templates` | Message template management |
| Proxy Settings | `/api/proxy` | Network proxy configuration |
| Dashboard | `/api/dashboard` | Statistical data retrieval |
| System Configuration | `/api/configs` | System parameter configuration |

### API Documentation Access

After starting the backend service, you can access complete API documentation through:
- **Swagger UI**: http://localhost:8081/docs
- **ReDoc**: http://localhost:8081/redoc

## Troubleshooting

### Common Issues

1. **Port Occupation**
   ```bash
   # Check port occupation
   lsof -i :5173  # Frontend port
   lsof -i :8081  # Backend port
   
   # Kill occupying process
   kill -9 <PID>
   ```

2. **Database Issues**
   ```bash
   # Reinitialize database
   cd backend
   python init_db.py
   ```

3. **Dependency Issues**
   ```bash
   # Frontend dependency issues
   cd frontend
   rm -rf node_modules package-lock.json
   npm install
   
   # Backend dependency issues
   cd backend
   pip install -r requirements.txt --force-reinstall
   ```

### Log Viewing

- Frontend logs: Browser developer tools console
- Backend logs: `backend/logs/app.log`
- Nginx logs: `/data/karry/sns-web/logs/nginx/`

## Development Guidelines

### Frontend Development Standards

1. **Use Vue 3 Composition API**
2. **Follow TypeScript type constraints**
3. **Use Element Plus component library**
4. **Unified use of Pinia for state management**
5. **Unified use of axios for API interfaces**

### Backend Development Standards

1. **Use FastAPI framework**
2. **Follow RESTful API design**
3. **Use Pydantic for data validation**
4. **Use SQLAlchemy ORM**
5. **Encapsulate business logic in services layer**

## Update Log

### v1.0.0 (Current Version)
- ✅ Complete user management system
- ✅ Message template and task management
- ✅ Search functionality implementation
- ✅ System configuration and dashboard
- ✅ Docker containerized deployment
- ✅ Complete API documentation

## Technical Support

If you encounter issues during use, please:

1. Check the troubleshooting section of this documentation
2. Review [API_PORTS.md](./API_PORTS.md) configuration instructions
3. Check project Issues
4. Contact the development team

---

**Note**: Before production deployment, please ensure to modify default security configurations, including database passwords, API keys, and other sensitive information.
