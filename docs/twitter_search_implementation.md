# Twitter搜索功能实现文档

## 功能概述

Twitter搜索功能通过Apify平台的两个Actor实现用户搜索：
1. Twitter Scraper (Actor ID: 61RPP7dywgiy0JPD0) - 用于搜索推文
2. Twitter User Scraper (Actor ID: V38PZzpEgOfeeWvZY) - 用于获取用户详细信息

## 搜索流程

### 1. 推文搜索
- 使用Twitter Scraper搜索包含关键词的推文
- 支持的搜索条件：
  - 关键词（必需）
  - 语言筛选（可选）
  - 地理位置（可选）
  - 最小转发数（可选）
  - 最小点赞数（可选）
  - 最小回复数（可选）
  - 日期范围（可选）

### 2. 用户信息获取
- 从搜索到的推文中提取用户名
- 使用Twitter User Scraper获取用户详细信息
- 支持的用户筛选条件：
  - 粉丝数范围
  - 认证状态
  - 地理位置

### 3. 数据处理和存储
- 对用户数据进行标准化处理
- 保存用户基本信息和匹配的推文
- 建立用户与搜索任务的关联关系
- 支持用户标签管理

## API接口

### 1. 创建搜索任务
```http
POST /api/search-tasks
Content-Type: application/json

{
  "name": "任务名称",
  "platform": "TWITTER",
  "search_params": {
    "keywords": ["关键词1", "关键词2"],
    "language": "ja",
    "min_followers": 100,
    "max_followers": 10000,
    "is_verified": false,
    "min_retweets": 10,
    "min_likes": 20,
    "min_replies": 5,
    "start_date": "2024-02-01",
    "end_date": "2024-02-20"
  },
  "results_limit": 100
}
```

### 2. 获取任务列表
```http
GET /api/search-tasks?platform=TWITTER&keyword=搜索词&page=1&pageSize=10
```

### 3. 获取任务详情
```http
GET /api/search-tasks/{task_id}
```

### 4. 获取任务结果
```http
GET /api/search-tasks/{task_id}/results?page=1&pageSize=20
```

## 数据结构

### 1. 用户数据结构
```json
{
  "username": "用户名",
  "displayName": "显示名称",
  "followersCount": 1000,
  "followingCount": 500,
  "verified": false,
  "location": "地理位置",
  "profileImageUrl": "头像URL",
  "description": "个人简介",
  "matchedTweet": {
    "id": "推文ID",
    "text": "推文内容",
    "retweets": 10,
    "likes": 20,
    "replies": 5,
    "created_at": "发布时间",
    "url": "推文链接"
  }
}
```

### 2. 搜索任务状态
- pending: 待处理
- running: 运行中
- processing: 处理中
- completed: 已完成
- failed: 失败
- stopped: 已停止

## 注意事项

1. API限制
- Apify API调用有并发和配额限制
- 建议控制搜索任务的并发数量
- 注意处理API错误和重试机制

2. 数据质量
- 用户数据可能不完整或过期
- 需要定期更新用户信息
- 注意处理重复数据

3. 性能优化
- 使用异步处理提高性能
- 实现数据缓存机制
- 优化数据库查询

## 后续优化计划

1. 功能增强
- [ ] 添加更多搜索条件支持
- [ ] 实现用户数据自动更新
- [ ] 添加数据导出功能
- [ ] 支持自定义过滤规则

2. 性能优化
- [ ] 实现任务队列管理
- [ ] 优化数据库索引
- [ ] 添加缓存机制
- [ ] 实现分布式处理

3. 用户体验
- [ ] 优化任务进度展示
- [ ] 添加数据可视化
- [ ] 实现实时通知
- [ ] 优化错误提示 