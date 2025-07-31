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
from fastapi import Depends

logger = logging.getLogger(__name__)

class TwitterSearchService:
    def __init__(self, api_token: str = None):
        # 优先使用传入的 API Token，否则从系统配置获取
        if not api_token:
            try:
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
        self.tweet_scraper_id = "61RPP7dywgiy0JPD0"  # Twitter Scraper Actor ID
        self.user_scraper_id = "V38PZzpEgOfeeWvZY"  # Twitter User Scraper Actor ID
        logger.info(f"TwitterSearchService initialized with token: {self.api_token[:5]}...")

    def _filter_users(
        self,
        users: List[Dict],
        min_followers: Optional[int] = None,
        max_followers: Optional[int] = None,
        is_verified: Optional[bool] = None
    ) -> List[Dict]:
        """
        根据条件过滤用户列表
        
        Args:
            users: 用户列表
            min_followers: 最小粉丝数
            max_followers: 最大粉丝数
            is_verified: 是否认证
            
        Returns:
            List[Dict]: 过滤后的用户列表
        """
        filtered_users = []
        
        for user in users:
            # 获取用户粉丝数
            followers_count = user.get("followersCount", 0)
            
            # 检查粉丝数范围
            if min_followers is not None and followers_count < min_followers:
                continue
            if max_followers is not None and followers_count > max_followers:
                continue
                
            # 检查认证状态
            if is_verified is not None:
                user_verified = user.get("verified", False)
                if user_verified != is_verified:
                    continue
            
            filtered_users.append(user)
            
        # 按粉丝数降序排序
        filtered_users.sort(key=lambda x: x.get("followersCount", 0), reverse=True)
        
        return filtered_users

    @staticmethod
    def execute_search(
        task_id: int,
        keywords: List[str],
        min_followers: Optional[int] = None,
        max_followers: Optional[int] = None,
        location: Optional[str] = None,
        is_verified: Optional[bool] = None,
        language: Optional[str] = None,
        min_retweets: Optional[int] = None,
        min_likes: Optional[int] = None,
        min_replies: Optional[int] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        results_limit: int = 1000,
        api_token: str = None
    ):
        """执行Twitter用户搜索"""
        try:
            # 初始化服务
            service = TwitterSearchService(api_token)
            
            # 获取数据库会话
            db = SessionLocal()
            
            try:
                # 获取任务
                task = db.query(SearchTask).filter(SearchTask.id == task_id).first()
                if not task:
                    raise ValueError(f"Task {task_id} not found")
                    
                # 更新任务状态为进行中
                task.status = "running"
                db.commit()
                
                # 执行搜索
                all_found_users = []  # 存储所有找到的用户
                filtered_users = []   # 存储符合条件的用户
                
                # 遍历所有关键词进行搜索
                for i, keyword in enumerate(keywords):
                    # 更新任务状态
                    task.status = f"processing keyword {i+1}/{len(keywords)}: {keyword}"
                    db.commit()
                        
                    # 搜索当前关键词的用户
                    current_users = service._search_users(
                        keyword,
                        results_limit,
                        location=location,
                        language=language,
                        min_retweets=min_retweets,
                        min_likes=min_likes,
                        start_date=start_date,
                        end_date=end_date
                    )
                    
                    # 为每个匹配的推文添加当前关键词，但只在推文文本实际包含关键词时添加
                    for user in current_users:
                        if "matchedTweet" in user:
                            tweet = user["matchedTweet"]
                            tweet_text = tweet.get("text", "").lower()
                            if "matched_keywords" not in tweet:
                                tweet["matched_keywords"] = []
                            # 只在推文文本实际包含关键词时才添加
                            if keyword.lower() in tweet_text and keyword not in tweet["matched_keywords"]:
                                tweet["matched_keywords"].append(keyword)
                    
                    logger.info(f"关键词 '{keyword}' 找到 {len(current_users)} 个用户")
                    
                    # 添加到总用户列表，只添加实际匹配到关键词的用户
                    for new_user in current_users:
                        if "matchedTweet" in new_user and new_user["matchedTweet"].get("matched_keywords"):
                            # 检查是否已存在该用户
                            existing_user = next((user for user in all_found_users if user["username"] == new_user["username"]), None)
                            if existing_user:
                                # 如果用户已存在，合并匹配的关键词
                                if "matchedTweet" in existing_user:
                                    existing_keywords = existing_user["matchedTweet"].get("matched_keywords", [])
                                    new_keywords = new_user["matchedTweet"].get("matched_keywords", [])
                                    existing_user["matchedTweet"]["matched_keywords"] = list(set(existing_keywords + new_keywords))
                            else:
                                # 如果是新用户，直接添加
                                all_found_users.append(new_user)
                    
                    # 去重
                    unique_users = list({user["username"]: user for user in all_found_users}.values())
                    logger.info(f"去重后总用户数: {len(unique_users)}")
                    
                    # 过滤用户
                    filtered_users = service._filter_users(
                        unique_users,
                        min_followers=min_followers,
                        max_followers=max_followers,
                        is_verified=is_verified
                    )
                    logger.info(f"过滤后用户数: {len(filtered_users)}")
                    
                    # 更新任务状态
                    task.total_results = len(filtered_users)
                    task.status = f"found {len(filtered_users)} users"
                    db.commit()
                
                # 更新任务状态为保存结果
                task.status = "saving results"
                db.commit()
                
                # 保存搜索结果
                saved_count = 0
                for user_data in filtered_users:
                    try:
                        # 检查用户是否已存在
                        existing_user = db.query(User).filter(
                            User.platform == Platform.TWITTER,
                            User.username == user_data["username"]
                        ).first()
                        
                        # 提取匹配的推文信息
                        matched_tweet = user_data.get("matchedTweet", {})
                        
                        # 构建profile_data
                        profile_data = {
                            'avatar_url': user_data.get("profileImageUrl", ""),
                            'followers_count': user_data.get("followersCount", 0),
                            'following_count': user_data.get("followingCount", 0),
                            'post_count': 0,
                            'bio': user_data.get("description", ""),
                            'is_verified': user_data.get("verified", False),
                            'is_private': False,
                            'website': None,
                            'category': None,
                            'location': user_data.get("location", ""),
                            'profile_url': f"https://twitter.com/{user_data['username']}",
                            'matched_posts': [{
                                "id": matched_tweet.get("id", ""),
                                "caption": matched_tweet.get("text", ""),  # 使用text作为caption
                                "text": matched_tweet.get("text", ""),
                                "retweets": matched_tweet.get("retweets", 0),
                                "likes": matched_tweet.get("likes", 0),
                                "replies": matched_tweet.get("replies", 0),
                                "timestamp": matched_tweet.get("created_at", ""),  # 使用created_at作为timestamp
                                "created_at": matched_tweet.get("created_at", ""),
                                "url": matched_tweet.get("url", ""),
                                "matched_keywords": matched_tweet.get("matched_keywords", [])  # 添加匹配的关键词信息
                            }] if matched_tweet else []
                        }
                        
                        if existing_user:
                            # 更新用户资料
                            existing_user.display_name = user_data.get("displayName", "")
                            existing_user.profile_data = profile_data
                            existing_user.updated_at = datetime.utcnow()
                            
                            # 1. 建立search_task_users关联关系
                            if task not in existing_user.search_tasks:
                                existing_user.search_tasks.append(task)
                            
                            # 2. 更新用户tags
                            if not existing_user.tags:
                                existing_user.tags = []
                            if task.name not in existing_user.tags:
                                existing_user.tags.append(task.name)
                                
                        else:
                            # 创建新用户
                            new_user = User(
                                platform=Platform.TWITTER,
                                username=user_data["username"],
                                display_name=user_data.get("displayName", ""),
                                profile_data=profile_data,
                                tags=[task.name],  # 初始化tags包含任务名称
                                created_at=datetime.utcnow(),
                                updated_at=datetime.utcnow()
                            )
                            db.add(new_user)
                            
                            # 建立search_task_users关联关系
                            new_user.search_tasks.append(task)
                        
                        saved_count += 1
                        if saved_count % 10 == 0:  # 每10条数据提交一次
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
                return filtered_users
                
            except Exception as e:
                # 更新任务状态为失败
                task.status = "failed"
                task.error_message = str(e)
                db.commit()
                logger.error(f"Error processing task {task_id}: {str(e)}")
                raise
            
            finally:
                db.close()
                
        except Exception as e:
            logger.error(f"Error in execute_search: {str(e)}")
            raise

    def _search_users(
        self,
        keyword: str,
        results_limit: int = 1000,
        location: Optional[str] = None,
        language: Optional[str] = None,
        min_retweets: Optional[int] = None,
        min_likes: Optional[int] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> List[Dict]:
        """
        两步搜索Twitter用户：
        1. 使用Twitter Scraper搜索相关推文
        2. 使用Twitter User Scraper获取用户详细信息
        """
        try:
            # 第一步：搜索相关推文
            logger.info(f"开始搜索关键词相关推文: {keyword}")
            
            # 构建搜索查询
            search_query = keyword
            if min_retweets:
                search_query += f" min_retweets:{min_retweets}"
            if min_likes:
                search_query += f" min_faves:{min_likes}"
            if language:
                search_query += f" lang:{language}"
            if location:
                search_query += f" near:{location}"
            
            # 运行推文搜索
            tweet_input = {
                "searchTerms": [search_query],
                "maxItems": min(results_limit, 200),  # 使用用户设置的数量限制
                "sort": "Top",
                "onlyTwitterBlue": False,
                "onlyVerifiedUsers": False,
                "startTime": self.format_date_for_apify(start_date) if start_date else None,
                "endTime": self.format_date_for_apify(end_date) if end_date else None
            }
            
            # 移除None值的键
            tweet_input = {k: v for k, v in tweet_input.items() if v is not None}
            
            logger.info(f"运行推文搜索，参数: {tweet_input}")
            tweet_run = self.apify_client.actor(self.tweet_scraper_id).call(run_input=tweet_input)
            
            # 收集推文信息和用户名
            tweets_by_url = {}  # url -> 推文信息映射
            unique_usernames = set()
            
            # 获取推文搜索结果
            for item in self.apify_client.dataset(tweet_run["defaultDatasetId"]).iterate_items():
                try:
                    if not isinstance(item, dict):
                        continue
                    
                    # 保存推文信息
                    tweet_info = {
                        "id": item.get("id", ""),
                        "text": item.get("text", ""),
                        "retweets": item.get("retweetCount", 0),
                        "likes": item.get("likeCount", 0),
                        "replies": item.get("replyCount", 0),
                        "created_at": item.get("createdAt", ""),
                        "url": item.get("url", "")
                    }
                    
                    # 从URL中提取用户名
                    url = item.get("url", "")
                    if url:
                        tweets_by_url[url] = tweet_info
                        # URL格式：https://x.com/username/status/id
                        parts = url.split("/")
                        if len(parts) > 3:
                            username = parts[3]
                            unique_usernames.add(username)
                    
                except Exception as e:
                    logger.error(f"处理推文数据时出错: {str(e)}")
                    continue
            
            logger.info(f"找到 {len(unique_usernames)} 个独特用户")
            
            if not unique_usernames:
                logger.warning("没有找到任何用户")
                return []
            
            # 第二步：获取用户详细信息
            logger.info("开始获取用户详细信息")
            
            # 构建用户搜索输入
            user_input = {
                "twitterHandles": list(unique_usernames),  # 使用正确的参数名
                "maxItems": len(unique_usernames),
                "includeUnavailableUsers": False,
                "proxy": {
                    "useApifyProxy": True,
                    "apifyProxyGroups": ["RESIDENTIAL"]
                }
            }
            
            logger.info(f"运行用户搜索，参数: {user_input}")
            
            try:
                user_run = self.apify_client.actor(self.user_scraper_id).call(run_input=user_input)
                
                # 获取用户详细信息
                all_users = []
                for user_data in self.apify_client.dataset(user_run["defaultDatasetId"]).iterate_items():
                    try:
                        if not isinstance(user_data, dict):
                            continue
                            
                        # 使用正确的字段名获取用户名
                        username = user_data.get("userName")  # 新格式使用 userName
                        if not username:
                            continue
                        
                        # 查找该用户的推文（改进匹配逻辑）
                        matched_tweet = None
                        username_lower = username.lower()
                        for url, tweet in tweets_by_url.items():
                            # 提取URL中的用户名部分
                            parts = url.split('/')
                            if len(parts) > 3:
                                url_username = parts[3].lower()
                                if url_username == username_lower:
                                    matched_tweet = tweet
                                    break
                        
                        # 标准化用户数据
                        if matched_tweet:
                            normalized_user = {
                                "username": username,
                                "displayName": user_data.get("name", ""),
                                "followersCount": user_data.get("followers", 0),
                                "followingCount": user_data.get("following", 0),
                                "verified": user_data.get("isVerified", False),
                                "location": user_data.get("location", ""),
                                "profileImageUrl": user_data.get("profilePicture", ""),
                                "description": user_data.get("description", ""),  # 从原始数据中获取description
                                "matchedTweet": matched_tweet
                            }

                            # 只有当用户满足基本条件时才添加到结果中
                            if normalized_user["username"]:
                                all_users.append(normalized_user)
                                logger.info(f"添加用户 {username} (粉丝数: {normalized_user['followersCount']}, 简介: {normalized_user['description'][:50]}..., 匹配推文: {matched_tweet.get('text', '')[:50]}...)")
                            else:
                                logger.debug(f"跳过用户 {username} (不满足基本条件)")
                        else:
                            logger.debug(f"跳过用户 {username} (没有找到匹配的推文)")
                            
                    except Exception as e:
                        logger.error(f"处理用户数据时出错: {str(e)}")
                        continue
                
                logger.info(f"成功获取 {len(all_users)} 个用户的详细信息")
                
                # 按粉丝数降序排序
                all_users.sort(key=lambda x: x["followersCount"], reverse=True)
                logger.info("用户列表已按粉丝数排序")
                
                return all_users
                
            except Exception as e:
                logger.error(f"获取用户详细信息时出错: {str(e)}")
                return []
            
        except Exception as e:
            logger.error(f"搜索用户时出错: {str(e)}")
            return []

    def _check_user_filters(
        self,
        user_data: Dict,
        min_followers: Optional[int] = None,
        max_followers: Optional[int] = None,
        is_verified: Optional[bool] = None,
        location: Optional[str] = None
    ) -> bool:
        """
        检查用户是否符合过滤条件
        """
        try:
            # 检查粉丝数范围
            followers_count = user_data.get("followersCount", 0)
            if min_followers is not None and followers_count < min_followers:
                logger.debug(f"用户 {user_data.get('username')} 粉丝数 {followers_count} 小于最小要求 {min_followers}")
                return False
            if max_followers is not None and followers_count > max_followers:
                logger.debug(f"用户 {user_data.get('username')} 粉丝数 {followers_count} 大于最大要求 {max_followers}")
                return False

            # 检查认证状态
            if is_verified is not None:
                verified = user_data.get("verified", False)
                if verified != is_verified:
                    logger.debug(f"用户 {user_data.get('username')} 认证状态 {verified} 不符合要求 {is_verified}")
                    return False

            # 检查地理位置
            if location:
                user_location = user_data.get("location", "").lower()
                if not user_location or location.lower() not in user_location:
                    logger.debug(f"用户 {user_data.get('username')} 地理位置 {user_location} 不符合要求 {location}")
                    return False

            logger.info(f"用户 {user_data.get('username')} 通过所有过滤条件")
            return True
            
        except Exception as e:
            logger.error(f"过滤用户时出错: {str(e)}")
            return False

    def format_date_for_apify(self, date_str: Optional[str]) -> Optional[str]:
        """
        格式化日期字符串为Apify Twitter Scraper所需的格式
        Args:
            date_str: ISO格式的日期字符串 (YYYY-MM-DD)
        Returns:
            格式化后的日期字符串 (YYYY-MM-DD HH:MM:SS)
        """
        try:
            if not date_str:
                return None
            # 将日期字符串转换为datetime对象
            date_obj = datetime.strptime(date_str, "%Y-%m-%d")
            # 根据是开始日期还是结束日期设置时间
            if "start" in str(date_str):
                # 开始日期设置为当天的00:00:00
                return date_obj.strftime("%Y-%m-%d 00:00:00")
            else:
                # 结束日期设置为当天的23:59:59
                return date_obj.strftime("%Y-%m-%d 23:59:59")
        except Exception as e:
            logger.error(f"日期格式化错误: {str(e)}")
            return None 