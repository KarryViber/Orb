#!/bin/bash

# 配置信息
REMOTE_USER="karry"
REMOTE_HOST="172.31.3.8"
REMOTE_PORT="22"
REMOTE_PATH="/data/karry/sns-web"
SSH_KEY_FILE="$HOME/.ssh/sns_web_deploy"
BACKUP_PATH="/data/karry/backups/$(date +%Y%m%d_%H%M%S)"

# 颜色输出函数
print_info() {
    echo -e "\033[36m[INFO] $1\033[0m"
}

print_warning() {
    echo -e "\033[33m[WARNING] $1\033[0m"
}

print_error() {
    echo -e "\033[31m[ERROR] $1\033[0m"
    exit 1
}

print_success() {
    echo -e "\033[32m[SUCCESS] $1\033[0m"
}

# 检查远程连接
print_info "Checking remote connection..."
if ! ssh -i "$SSH_KEY_FILE" -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "exit" 2>/dev/null; then
    print_error "Cannot connect to remote server. Please check your SSH configuration."
fi

# 生成SSH密钥（如果不存在）
if [ ! -f "$SSH_KEY_FILE" ]; then
    print_info "Generating SSH key..."
    mkdir -p "$HOME/.ssh"
    ssh-keygen -t rsa -b 4096 -f "$SSH_KEY_FILE" -N "RGpPacUXT37aT"
    # 将公钥复制到服务器
    ssh-copy-id -i "$SSH_KEY_FILE" -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST"
fi

# 备份远程数据
print_info "Creating backup of remote data..."
ssh -i "$SSH_KEY_FILE" -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $BACKUP_PATH && \
    if [ -d $REMOTE_PATH ]; then \
        cp -r $REMOTE_PATH/* $BACKUP_PATH/ 2>/dev/null || true; \
        print_success 'Backup created at $BACKUP_PATH'; \
    fi"

# 在本地构建前端镜像
print_info "Building frontend locally..."
cd frontend
if ! docker build --platform linux/amd64 -t sns-web-frontend .; then
    print_error "Frontend build failed"
fi
docker save sns-web-frontend > ../sns-web-frontend.tar
cd ..

# 在本地构建后端镜像
print_info "Building backend locally..."
cd backend
if ! docker build --platform linux/amd64 -t sns-web-backend .; then
    print_error "Backend build failed"
fi
docker save sns-web-backend > ../sns-web-backend.tar
cd ..

# 创建远程目录
print_info "Creating remote directory..."
ssh -i "$SSH_KEY_FILE" -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_PATH"

# 复制文件到服务器
print_info "Copying files to server..."
if ! scp -i "$SSH_KEY_FILE" -P "$REMOTE_PORT" \
    docker-compose.yml \
    nginx.conf \
    sns-web-frontend.tar \
    sns-web-backend.tar \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/"; then
    print_error "Failed to copy files to server"
fi

# 在服务器上加载镜像和启动服务
print_info "Loading images and starting services on server..."
ssh -i "$SSH_KEY_FILE" -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "cd $REMOTE_PATH && \
    # 停止现有服务
    docker-compose down && \
    # 加载新镜像
    docker load < sns-web-frontend.tar && \
    docker load < sns-web-backend.tar && \
    # 启动服务
    docker-compose up -d"

# 检查服务状态
print_info "Checking service status..."
ssh -i "$SSH_KEY_FILE" -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" "cd $REMOTE_PATH && \
    if ! docker-compose ps | grep -q 'Up'; then \
        print_error 'Services failed to start properly'; \
        print_info 'Rolling back to backup...'; \
        docker-compose down; \
        rm -rf $REMOTE_PATH/*; \
        cp -r $BACKUP_PATH/* $REMOTE_PATH/; \
        docker-compose up -d; \
        exit 1; \
    fi"

# 清理本地临时文件
print_info "Cleaning up local files..."
rm sns-web-frontend.tar sns-web-backend.tar

print_success "Deployment completed successfully!" 