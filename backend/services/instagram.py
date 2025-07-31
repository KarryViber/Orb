from typing import Dict, Any, List, Optional
from sqlalchemy.orm import Session
from models.database import SessionLocal
from models.models import SearchTask, User, Platform, SystemConfig
import logging
import os
from datetime import datetime
from apify_client import ApifyClient
import json
import asyncio
import time

logger = logging.getLogger(__name__)

class InstagramSearchService:
    def __init__(self, api_token: str = None):
        # 优先使用传入的 API Token，否则从系统配置获取
        if not api_token:
            try:
                from models.models import SystemConfig
                from models.database import SessionLocal
                
                with SessionLocal() as db:
                    config = db.query(SystemConfig).filter(
                        SystemConfig.key == "APIFY_API_TOKEN"
                    ).first()
                    if config and config.value:
                        api_token = config.value
                        logger.info("从系统配置获取到 API Token")
            except Exception as e:
                logger.error(f"从系统配置获取 API Token 失败: {str(e)}")
        
        # 如果还是没有获取到，则使用环境变量
        self.api_token = api_token or os.getenv('APIFY_API_TOKEN', '')
        self.apify_client = ApifyClient(self.api_token)
        self.actor_id = os.getenv('APIFY_INSTAGRAM_ACTOR', '')
        logger.info(f"InstagramSearchService initialized with token: {self.api_token[:5]}...")

    @staticmethod
    def execute_search(
        task_id: int,
        keywords: List[str],
        min_followers: Optional[int] = None,
        max_followers: Optional[int] = None,
        location: Optional[str] = None,
        is_verified: Optional[bool] = None,
        is_private: Optional[bool] = None,
        is_business: Optional[bool] = None,
        results_limit: int = 1000,
        api_token: str = None
    ):
        """执行Instagram用户搜索"""
        service = InstagramSearchService(api_token=api_token)
        try:
            with SessionLocal() as db:
                # 更新任务状态为进行中
                task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
                if not task:
                    logger.error(f"Task {task_id} not found")
                    return
                
                task.status = "running"
                db.commit()

                try:
                    # 执行Apify搜索
                    all_found_users = []  # 存储所有找到的用户
                    filtered_users = []   # 存储符合条件的用户
                    
                    # 构建follower_range字典
                    follower_range = {
                        "min": min_followers,
                        "max": max_followers
                    }
                    
                    # 遍历所有关键词进行搜索
                    for i, keyword in enumerate(keywords):
                        # 更新任务状态
                        task.status = f"processing keyword {i+1}/{len(keywords)}: {keyword}"
                        db.commit()
                            
                        # 搜索当前关键词的用户
                        current_users = service._search_users(keyword, results_limit)
                        logger.info(f"关键词 '{keyword}' 找到 {len(current_users)} 个用户")
                        
                        # 添加到总用户列表
                        all_found_users.extend(current_users)
                        
                        # 去重
                        unique_users = list({user["username"]: user for user in all_found_users}.values())
                        logger.info(f"去重后总用户数: {len(unique_users)}")
                        
                        # 过滤用户
                        filtered_users = [
                            user for user in unique_users
                            if service._check_user_filters(
                                user,
                                follower_range,
                                following_range={},
                                post_range={},
                                location=location,
                                is_verified=is_verified,
                                is_private=is_private,
                                is_business=is_business
                            )
                        ]
                        
                        # 更新当前找到的用户数量
                        current_count = len(filtered_users)
                        logger.info(f"当前关键词 '{keyword}' 处理完成，累计符合条件的用户数: {current_count}")
                        
                        # 更新任务状态
                        task.result_count = current_count
                        db.commit()
                    
                    logger.info(f"搜索完成，最终找到符合条件的用户数: {len(filtered_users)}")
                    
                    # 更新任务状态为保存结果
                    task.status = "saving results"
                    db.commit()
                    
                    # 保存搜索结果
                    saved_count = 0
                    for user_data in filtered_users:
                        try:
                            # 检查用户是否已存在
                            existing_user = db.query(User).filter(
                                User.platform == Platform.INSTAGRAM,
                                User.username == user_data["username"]
                            ).first()
                            
                            if existing_user:
                                # 更新用户资料
                                existing_user.display_name = user_data.get("fullName", "")
                                existing_user.profile_data = {
                                    "avatar_url": user_data.get("profilePicUrl"),
                                    "followers_count": user_data.get("followersCount", 0),
                                    "following_count": user_data.get("followsCount", 0),
                                    "posts_count": user_data.get("postsCount", 0),
                                    "bio": user_data.get("biography", ""),
                                    "is_verified": user_data.get("isVerified", False),
                                    "is_private": user_data.get("isPrivate", False),
                                    "is_business": user_data.get("isBusinessAccount", False),
                                    "website": user_data.get("externalUrl"),
                                    "category": user_data.get("category"),
                                    "profile_url": f"https://www.instagram.com/{user_data['username']}",
                                    "matched_posts": user_data.get("matched_posts", [])
                                }
                                existing_user.updated_at = datetime.utcnow()
                                
                                # 获取任务
                                task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
                                
                                # 1. 建立search_task_users关联关系
                                if task not in existing_user.search_tasks:
                                    existing_user.search_tasks.append(task)
                                
                                # 2. 更新用户tags
                                if not existing_user.tags:
                                    existing_user.tags = []
                                if task.name not in existing_user.tags:
                                    existing_user.tags.append(task.name)
                                
                            else:
                                # 获取任务
                                task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
                                
                                # 创建新用户
                                new_user = User(
                                    platform=Platform.INSTAGRAM,
                                    username=user_data["username"],
                                    display_name=user_data.get("fullName", ""),
                                    profile_data={
                                        "avatar_url": user_data.get("profilePicUrl"),
                                        "followers_count": user_data.get("followersCount", 0),
                                        "following_count": user_data.get("followsCount", 0),
                                        "posts_count": user_data.get("postsCount", 0),
                                        "bio": user_data.get("biography", ""),
                                        "is_verified": user_data.get("isVerified", False),
                                        "is_private": user_data.get("isPrivate", False),
                                        "is_business": user_data.get("isBusinessAccount", False),
                                        "website": user_data.get("externalUrl"),
                                        "category": user_data.get("category"),
                                        "profile_url": f"https://www.instagram.com/{user_data['username']}",
                                        "matched_posts": user_data.get("matched_posts", [])
                                    },
                                    tags=[task.name],  # 初始化tags包含任务名称
                                    created_at=datetime.utcnow(),
                                    updated_at=datetime.utcnow()
                                )
                                db.add(new_user)
                                
                                # 建立search_task_users关联关系
                                new_user.search_tasks.append(task)
                            
                            saved_count += 1
                            if saved_count % 10 == 0:
                                db.commit()
                                logger.info(f"已保存 {saved_count}/{len(filtered_users)} 个用户")
                                
                        except Exception as e:
                            logger.error(f"保存用户数据时出错: {str(e)}")
                            continue
                    
                    # 最后一次提交
                    db.commit()
                    
                    # 更新任务状态
                    task.status = "completed"
                    task.result_count = saved_count
                    task.is_completed = True
                    task.completed_at = datetime.utcnow()
                    db.commit()
                    
                    logger.info(f"Task {task_id} completed successfully with {saved_count} users")
                
                except Exception as e:
                    # 更新任务状态为失败
                    task.status = "failed"
                    task.error_message = str(e)
                    db.commit()
                    logger.error(f"Error processing task {task_id}: {str(e)}")
                    raise
        
        except Exception as e:
            logger.error(f"Error in execute_search for task {task_id}: {str(e)}")
            raise

    def _search_users(self, keyword: str, results_limit: int = 1000) -> List[Dict]:
        """使用Apify API搜索Instagram用户"""
        try:
            logger.info(f"开始搜索关键词: {keyword}")
            
            # 第一步：使用 Instagram Hashtag Scraper 获取标签下的帖子和用户
            hashtag_actor_id = "apify/instagram-hashtag-scraper"
            logger.info(f"使用Hashtag Scraper Actor ID: {hashtag_actor_id}")
            
            # 运行Hashtag搜索任务
            hashtag_input = {
                "hashtags": [keyword.replace(" ", "")],
                "resultsLimit": results_limit,  # 使用传入的结果限制
                "searchType": "hashtag",
                "maxRequestRetries": 3,
                "maxConcurrency": 10,
                "maxPostsPerUser": 50,  # 限制每个用户的最大帖子数
                "maxPostsPerHashtag": results_limit,  # 使用传入的结果限制作为每个标签的最大帖子数
                "extendOutputFunction": """
                async ({ data, item, page, customData }) => {
                    return {
                        ...item,
                        ownerUsername: item.ownerUsername || item.owner?.username,
                        caption: item.caption,
                        hashtags: item.hashtags,
                        mentions: item.mentions,
                        url: item.url,
                        commentsCount: item.commentsCount,
                        likesCount: item.likesCount
                    }
                }
                """,
                "proxy": {
                    "useApifyProxy": True,
                    "apifyProxyGroups": ["RESIDENTIAL"]
                }
            }
            
            logger.info(f"Hashtag搜索参数: {hashtag_input}")
            
            # 运行Hashtag搜索
            hashtag_run = self.apify_client.actor(hashtag_actor_id).call(run_input=hashtag_input)
            logger.info(f"Hashtag搜索任务已启动，运行ID: {hashtag_run['id']}")
            
            # 获取Hashtag搜索结果
            unique_usernames = set()
            hashtag_dataset_id = hashtag_run.get("defaultDatasetId")
            if not hashtag_dataset_id:
                logger.error("未找到Hashtag搜索数据集ID")
                return []
            
            logger.info(f"Hashtag搜索数据集ID: {hashtag_dataset_id}")
            
            # 收集用户的帖子信息
            user_posts = {}
            
            # 使用分页方式获取数据
            offset = 0
            limit = 100
            total_items = 0
            
            while True:
                items = list(self.apify_client.dataset(hashtag_dataset_id).iterate_items(offset=offset, limit=limit))
                if not items:
                    break
                    
                total_items += len(items)
                logger.info(f"获取到第 {offset+1}-{offset+len(items)} 条数据")
                
                for item in items:
                    if "ownerUsername" in item:
                        username = item["ownerUsername"]
                        unique_usernames.add(username)
                        
                        # 为每个用户收集帖子信息
                        if username not in user_posts:
                            user_posts[username] = []
                        
                        # 添加帖子信息
                        post_info = {
                            "url": item.get("url"),
                            "caption": item.get("caption", ""),
                            "likes_count": item.get("likesCount", 0),
                            "comments_count": item.get("commentsCount", 0),
                            "timestamp": item.get("timestamp") or item.get("created_at"),
                            "hashtags": item.get("hashtags", [])
                        }
                        user_posts[username].append(post_info)
                
                offset += limit
                if len(items) < limit:  # 如果获取的数据少于限制，说明已经到达末尾
                    break
            
            logger.info(f"总共获取 {total_items} 条帖子数据")
            logger.info(f"找到 {len(unique_usernames)} 个独特用户")
            
            if not unique_usernames:
                logger.warning("没有找到任何用户，跳过Profile搜索步骤")
                return []
            
            # 第二步：使用 Instagram Profile Scraper 获取用户详细信息
            profile_actor_id = "zuzka/instagram-profile-scraper"
            logger.info(f"使用Profile Scraper Actor ID: {profile_actor_id}")
            
            # 分批处理用户列表，每批处理更多用户以提高效率
            batch_size = 200  # 增加批次大小
            max_retries = 3   # 添加重试机制
            all_users_data = []
            usernames_list = list(unique_usernames)
            
            for i in range(0, len(usernames_list), batch_size):
                batch_usernames = usernames_list[i:i + batch_size]
                logger.info(f"处理第 {i//batch_size + 1} 批用户，共 {len(batch_usernames)} 个")
                
                # 添加重试逻辑
                for retry in range(max_retries):
                    try:
                        # 运行Profile搜索任务
                        profile_input = {
                            "usernames": batch_usernames,
                            "resultsLimit": batch_size,
                            "maxRequestRetries": 3,
                            "maxConcurrency": 10,
                            "proxy": {
                                "useApifyProxy": True,
                                "apifyProxyGroups": ["RESIDENTIAL"]
                            }
                        }
                        
                        logger.info(f"Profile搜索参数: {profile_input}")
                        
                        # 运行Profile搜索
                        profile_run = self.apify_client.actor(profile_actor_id).call(run_input=profile_input)
                        
                        # 获取Profile搜索结果
                        profile_dataset_id = profile_run.get("defaultDatasetId")
                        if not profile_dataset_id:
                            logger.error(f"未找到第 {i//batch_size + 1} 批Profile搜索数据集ID")
                            continue
                        
                        # 收集用户数据
                        batch_users = []
                        for item in self.apify_client.dataset(profile_dataset_id).iterate_items():
                            if isinstance(item, dict) and "username" in item:
                                # 添加匹配的帖子信息到用户数据中
                                username = item["username"]
                                item["matched_posts"] = user_posts.get(username, [])
                                batch_users.append(item)
                        
                        all_users_data.extend(batch_users)
                        logger.info(f"第 {i//batch_size + 1} 批用户处理完成，当前共获取 {len(all_users_data)} 个用户的详细信息")
                        break  # 如果成功，跳出重试循环
                        
                    except Exception as e:
                        logger.error(f"处理第 {i//batch_size + 1} 批用户时出错 (重试 {retry + 1}/{max_retries}): {str(e)}")
                        if retry == max_retries - 1:  # 如果是最后一次重试
                            logger.error(f"处理第 {i//batch_size + 1} 批用户失败，跳过该批次")
                        else:
                            time.sleep(5 * (retry + 1))  # 增加重试等待时间
                            continue
            
            logger.info(f"所有批次处理完成，最终获取 {len(all_users_data)} 个用户的详细信息")
            return all_users_data
            
        except Exception as e:
            logger.error(f"Error searching for keyword {keyword}: {str(e)}", exc_info=True)
            return []

    def _check_user_filters(
        self,
        user_data: Dict,
        follower_range: Dict[str, Optional[int]],
        following_range: Dict[str, Optional[int]],
        post_range: Dict[str, Optional[int]],
        location: Optional[str] = None,
        is_verified: Optional[bool] = None,
        is_private: Optional[bool] = None,
        is_business: Optional[bool] = None
    ) -> bool:
        """检查用户是否符合过滤条件"""
        # 获取用户统计数据
        followers_count = user_data.get('followersCount', 0)
        following_count = user_data.get('followsCount', 0)
        posts_count = user_data.get('postsCount', 0)
        
        logger.info(f"检查用户过滤条件 - 用户: {user_data.get('username')}")
        logger.info(f"粉丝数: {followers_count}, 范围: {follower_range}")
        logger.info(f"关注数: {following_count}, 范围: {following_range}")
        logger.info(f"帖子数: {posts_count}, 范围: {post_range}")
        logger.info(f"地理位置要求: {location}")
        logger.info(f"认证要求: {is_verified}")
        logger.info(f"私密要求: {is_private}")
        logger.info(f"商业账号要求: {is_business}")
        
        # 检查粉丝数范围
        if isinstance(follower_range, dict):
            min_followers = follower_range.get("min")
            max_followers = follower_range.get("max")
            
            if min_followers is not None and followers_count < min_followers:
                logger.info(f"不满足最小粉丝数要求: {followers_count} < {min_followers}")
                return False
            if max_followers is not None and followers_count > max_followers:
                logger.info(f"超过最大粉丝数要求: {followers_count} > {max_followers}")
                return False
        
        # 检查关注数范围
        if isinstance(following_range, dict):
            min_following = following_range.get("min")
            max_following = following_range.get("max")
            
            if min_following is not None and following_count < min_following:
                logger.info(f"不满足最小关注数要求: {following_count} < {min_following}")
                return False
            if max_following is not None and following_count > max_following:
                logger.info(f"超过最大关注数要求: {following_count} > {max_following}")
                return False
        
        # 检查帖子数范围
        if isinstance(post_range, dict):
            min_posts = post_range.get("min")
            max_posts = post_range.get("max")
            
            if min_posts is not None and posts_count < min_posts:
                logger.info(f"不满足最小帖子数要求: {posts_count} < {min_posts}")
                return False
            if max_posts is not None and posts_count > max_posts:
                logger.info(f"超过最大帖子数要求: {posts_count} > {max_posts}")
                return False
        
        # 检查认证状态
        if is_verified is not None:
            user_verified = user_data.get('isVerified', False)
            if user_verified != is_verified:
                logger.info(f"认证状态不符: 要求={is_verified}, 实际={user_verified}")
                return False
        
        # 检查私密状态
        if is_private is not None:
            user_private = user_data.get('isPrivate', False)
            if user_private != is_private:
                logger.info(f"私密状态不符: 要求={is_private}, 实际={user_private}")
                return False
        
        # 检查商业账号状态
        if is_business is not None:
            user_business = user_data.get('isBusinessAccount', False)
            if user_business != is_business:
                logger.info(f"商业账号状态不符: 要求={is_business}, 实际={user_business}")
                return False
        
        # 检查地理位置
        if location:
            user_location = user_data.get("location", "").lower()
            if location.lower() not in user_location:
                logger.info(f"地理位置不符: 要求={location}, 实际={user_location}")
                return False
        
        logger.info("用户满足所有过滤条件")
        return True

class InstagramMessageService:
    def __init__(self):
        # 从系统配置获取 API Token
        try:
            from models.models import SystemConfig
            from models.database import SessionLocal
            
            with SessionLocal() as db:
                config = db.query(SystemConfig).filter(
                    SystemConfig.key == "APIFY_API_TOKEN"
                ).first()
                if config and config.value:
                    api_token = config.value
                    logger.info("从系统配置获取到 API Token")
                else:
                    api_token = os.getenv('APIFY_API_TOKEN')
                    logger.info("从环境变量获取 API Token")
        except Exception as e:
            logger.error(f"从系统配置获取 API Token 失败: {str(e)}")
            api_token = os.getenv('APIFY_API_TOKEN')
        
        self.apify_client = ApifyClient(api_token)
        self.actor_id = os.getenv('APIFY_INSTAGRAM_MESSAGE_ACTOR')
        self._actor_ready = False  # Actor状态缓存

    def _get_latest_cookies(self) -> List[Dict]:
        """从配置中获取最新的cookie"""
        try:
            from models.models import SystemConfig
            from models.database import SessionLocal
            
            with SessionLocal() as db:
                # 尝试从系统配置获取cookie
                config = db.query(SystemConfig).filter(
                    SystemConfig.key == "INSTAGRAM_COOKIES"
                ).first()
                
                if config and config.value:
                    try:
                        cookies = json.loads(config.value)
                        logger.info(f"从系统配置获取到cookie: {config.value[:100]}...")
                        
                        # 验证cookies格式
                        if isinstance(cookies, list) and cookies and all(
                            isinstance(c, dict) and 'name' in c and 'value' in c 
                            for c in cookies
                        ):
                            return cookies
                        
                        logger.error(f"Cookie格式无效，需要是包含name和value字段的字典列表")
                        return []
                        
                    except json.JSONDecodeError as e:
                        logger.error(f"Cookie格式错误: {str(e)}")
                        return []
                else:
                    logger.warning("系统配置中未找到cookie")
                    return []
                
        except Exception as e:
            logger.error(f"获取最新cookie失败: {str(e)}")
            return []

    async def send_message(self, username: str, message: str) -> Dict[str, Any]:
        """发送Instagram私信"""
        try:
            logger.info(f"准备向用户 {username} 发送消息")
            logger.info(f"使用的Actor ID: {self.actor_id}")
            logger.info(f"API Token: {self.apify_client.token[:5]}...")  # 只显示前5个字符
            
            # 获取最新的cookies
            cookies = self._get_latest_cookies()
            if not cookies:
                error_msg = "未能获取有效的cookies"
                logger.error(error_msg)
                return {"success": False, "error": error_msg}
            
            # 准备发送消息的参数
            run_input = {
                "Cookies": cookies,  # 使用正确的参数名 Cookies
                "Delay": "5",
                "Instagram_UserName_List": [username],
                "Message": message
            }
            
            logger.info("准备运行消息发送Actor")
            logger.info(f"发送参数: {json.dumps(run_input, ensure_ascii=False)}")
            
            # 运行Actor
            try:
                run = self.apify_client.actor(self.actor_id).call(run_input=run_input)
                
                # 获取运行ID
                run_id = run.get("id")
                if not run_id:
                    error_msg = "未能获取运行ID"
                    logger.error(error_msg)
                    return {"success": False, "error": error_msg}
                
                logger.info(f"消息发送任务运行ID: {run_id}")
                
                # 等待运行完成
                max_wait_time = 180  # 增加等待时间到180秒
                start_time = time.time()
                
                while True:
                    if time.time() - start_time > max_wait_time:
                        error_msg = "发送消息超时"
                        logger.error(error_msg)
                        return {"success": False, "error": error_msg}
                    
                    status = self.apify_client.run(run_id).get()
                    logger.info(f"Actor运行状态: {status['status']}")
                    
                    if status["status"] == "SUCCEEDED":
                        logger.info("Actor运行成功")
                        break
                    elif status["status"] in ["FAILED", "TIMED-OUT", "ABORTED"]:
                        error_msg = f"Actor运行失败，状态: {status['status']}"
                        logger.error(error_msg)
                        # 获取详细的错误信息
                        error_details = self.get_actor_log(run_id)
                        logger.error(f"Actor运行日志: {error_details}")
                        return {"success": False, "error": error_msg, "details": error_details}
                    
                    await asyncio.sleep(2)
                
                # 获取结果
                dataset_id = run.get("defaultDatasetId")
                if not dataset_id:
                    error_msg = "未能获取结果数据集ID"
                    logger.error(error_msg)
                    return {"success": False, "error": error_msg}
                
                items = list(self.apify_client.dataset(dataset_id).iterate_items())
                
                if not items:
                    error_msg = "未收到发送结果"
                    logger.error(error_msg)
                    return {"success": False, "error": error_msg}
                
                result = items[0]
                logger.info(f"发送结果: {result}")
                
                # 检查消息发送状态
                if result.get("Status") == "Failed":
                    error_msg = f"消息发送失败: {result.get('Failed_Reason') or '未知原因'}"
                    logger.error(error_msg)
                    # 尝试获取更详细的错误信息
                    error_details = {
                        "actor_log": self.get_actor_log(run_id),
                        "result": result
                    }
                    return {
                        "success": False,
                        "error": error_msg,
                        "details": error_details
                    }
                
                return {
                    "success": True,
                    "message": "消息发送成功",
                    "details": result
                }
                
            except Exception as e:
                error_msg = f"运行Actor时发生错误: {str(e)}"
                logger.error(error_msg)
                return {"success": False, "error": error_msg}
            
        except Exception as e:
            error_msg = f"发送消息时发生错误: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}

    def get_cookies(self) -> dict:
        """获取当前的Cookie状态"""
        try:
            # 基础时间戳（一年后）
            base_expires = time.time() + 365 * 24 * 60 * 60
            
            cookies = [
                {
                    "name": "mid",
                    "value": os.getenv('INSTAGRAM_MID', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires,
                    "httpOnly": True,
                    "secure": True
                },
                {
                    "name": "datr",
                    "value": os.getenv('INSTAGRAM_DATR', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires + 30 * 24 * 60 * 60,
                    "httpOnly": True,
                    "secure": True
                },
                {
                    "name": "ig_did",
                    "value": os.getenv('INSTAGRAM_IG_DID', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires + 60 * 24 * 60 * 60,
                    "httpOnly": True,
                    "secure": True
                },
                {
                    "name": "ig_nrcb",
                    "value": os.getenv('INSTAGRAM_IG_NRCB', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires + 60 * 24 * 60 * 60,
                    "httpOnly": False,
                    "secure": True
                },
                {
                    "name": "ps_l",
                    "value": os.getenv('INSTAGRAM_PS_L', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires + 90 * 24 * 60 * 60,
                    "httpOnly": True,
                    "secure": True,
                    "sameSite": "Lax"
                },
                {
                    "name": "ps_n",
                    "value": os.getenv('INSTAGRAM_PS_N', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires + 90 * 24 * 60 * 60,
                    "httpOnly": True,
                    "secure": True
                },
                {
                    "name": "dpr",
                    "value": "1",
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires - 180 * 24 * 60 * 60,
                    "httpOnly": False,
                    "secure": True
                },
                {
                    "name": "wd",
                    "value": os.getenv('INSTAGRAM_WD', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires - 180 * 24 * 60 * 60,
                    "httpOnly": False,
                    "secure": True,
                    "sameSite": "Lax"
                },
                {
                    "name": "csrftoken",
                    "value": os.getenv('INSTAGRAM_CSRFTOKEN', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires + 30 * 24 * 60 * 60,
                    "httpOnly": False,
                    "secure": True
                },
                {
                    "name": "sessionid",
                    "value": os.getenv('INSTAGRAM_SESSIONID', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires + 30 * 24 * 60 * 60,
                    "httpOnly": True,
                    "secure": True
                },
                {
                    "name": "ds_user_id",
                    "value": os.getenv('INSTAGRAM_DS_USER_ID', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": base_expires - 180 * 24 * 60 * 60,
                    "httpOnly": False,
                    "secure": True
                },
                {
                    "name": "rur",
                    "value": os.getenv('INSTAGRAM_RUR', ''),
                    "domain": ".instagram.com",
                    "path": "/",
                    "expires": -1,
                    "httpOnly": True,
                    "secure": True,
                    "sameSite": "Lax"
                }
            ]
            
            # 过滤掉空值的cookie
            valid_cookies = [cookie for cookie in cookies if cookie["value"]]
            logger.info(f"有效的cookie数量: {len(valid_cookies)}")
            
            if not valid_cookies:
                logger.error("没有找到有效的cookie")
                return []
            
            return valid_cookies
            
        except Exception as e:
            logger.error(f"获取Cookie失败: {str(e)}")
            return []

    async def check_actor_status(self) -> dict:
        """检查Apify Actor的状态"""
        try:
            # 获取Actor详情
            actor = self.apify_client.actor(self.actor_id)
            actor_info = actor.get()
            
            # 获取最近的运行记录
            runs = actor.runs().list(limit=1, desc=True)
            latest_run = runs.items[0] if runs.items else None
            
            status = {
                "isReady": True,  # 默认认为Actor就绪
                "actor_info": {
                    "id": actor_info.get("id"),
                    "name": actor_info.get("name"),
                    "status": actor_info.get("status")
                }
            }
            
            if latest_run:
                status["latest_run"] = {
                    "id": latest_run.get("id"),
                    "status": latest_run.get("status"),
                    "startedAt": latest_run.get("startedAt").isoformat() if latest_run.get("startedAt") else None,
                    "finishedAt": latest_run.get("finishedAt").isoformat() if latest_run.get("finishedAt") else None
                }
            
            return status
            
        except Exception as e:
            logger.error(f"检查Actor状态失败: {str(e)}")
            return {"isReady": False, "error": str(e)}

    def get_actor_log(self, run_id: str) -> str:
        """获取Actor运行日志"""
        try:
            log = self.apify_client.run(run_id).log().get()
            return log
        except Exception as e:
            logger.error(f"获取Actor日志失败: {str(e)}")
            return "无法获取日志" 