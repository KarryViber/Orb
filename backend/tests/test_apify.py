import logging
import os
import sys
from datetime import datetime
import time

import requests
from apify_client import ApifyClient
import pytest
from typing import Dict, Any

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 设置环境变量
os.environ["PYTHONPATH"] = "/Users/karryz/Documents/Website/SNS_web_corsur/backend"

# 从.env文件加载配置
from dotenv import load_dotenv
load_dotenv()

class TestInstagramSearch:
    @pytest.fixture(scope="class")
    def api_client(self):
        """初始化API客户端"""
        return requests.Session()

    @pytest.fixture(scope="class")
    def apify_client(self):
        """初始化Apify客户端"""
        return ApifyClient(os.getenv("APIFY_API_TOKEN"))

    def test_apify_connection(self, apify_client):
        """测试与Apify API的连接"""
        logger.info("=== 测试 Apify API 连接 ===")
        
        try:
            user_info = apify_client.user().get()
            logger.info(f"成功获取用户信息: {user_info}")
            assert user_info is not None
            assert "username" in user_info
        except Exception as e:
            logger.error(f"获取用户信息失败: {str(e)}")
            pytest.fail("Apify API连接测试失败")

    def test_create_search_task(self, api_client):
        """测试创建搜索任务"""
        logger.info("\n=== 测试创建搜索任务 ===")
        
        task_data = {
            "name": "测试搜索任务",
            "platform": "instagram",
            "max_users": 10,
            "criteria": {
                "keywords": ["cristiano"],
                "follower_range": {
                    "min": 1000,
                    "max": None
                },
                "location": None,
                "is_verified": None,
                "is_private": None
            }
        }
        
        response = api_client.post(
            "http://localhost:8888/search-tasks",
            json=task_data
        )
        
        assert response.status_code == 200
        task = response.json()
        assert task["name"] == task_data["name"]
        assert task["status"] == "pending"
        return task["id"]

    def test_filter_conditions(self, api_client):
        """测试不同的过滤条件"""
        logger.info("\n=== 测试过滤条件 ===")
        
        test_cases = [
            {
                "name": "认证用户测试",
                "criteria": {
                    "keywords": ["nike"],
                    "follower_range": {"min": 1000000, "max": None},
                    "is_verified": True,
                    "is_private": False
                }
            },
            {
                "name": "地理位置测试",
                "criteria": {
                    "keywords": ["photographer"],
                    "follower_range": {"min": 10000, "max": 100000},
                    "location": "New York"
                }
            },
            {
                "name": "粉丝数范围测试",
                "criteria": {
                    "keywords": ["fitness"],
                    "follower_range": {"min": 50000, "max": 200000}
                }
            }
        ]
        
        for test_case in test_cases:
            logger.info(f"\n测试用例: {test_case['name']}")
            response = api_client.post(
                "http://localhost:8888/search-tasks",
                json={
                    "name": test_case["name"],
                    "platform": "instagram",
                    "max_users": 5,
                    "criteria": test_case["criteria"]
                }
            )
            
            assert response.status_code == 200
            task = response.json()
            assert task["status"] == "pending"
            
            # 等待任务完成
            self._wait_for_task_completion(api_client, task["id"])
            
            # 验证结果
            results = api_client.get(f"http://localhost:8888/search-tasks/{task['id']}/results")
            assert results.status_code == 200
            users = results.json()
            
            # 验证过滤条件是否生效
            for user in users:
                if "is_verified" in test_case["criteria"]:
                    assert user["profile_data"]["is_verified"] == test_case["criteria"]["is_verified"]
                if "is_private" in test_case["criteria"]:
                    assert user["profile_data"]["is_private"] == test_case["criteria"]["is_private"]
                if "location" in test_case["criteria"]:
                    assert test_case["criteria"]["location"].lower() in user["profile_data"].get("location", "").lower()
                
                followers = user["profile_data"]["followers_count"]
                if test_case["criteria"]["follower_range"].get("min"):
                    assert followers >= test_case["criteria"]["follower_range"]["min"]
                if test_case["criteria"]["follower_range"].get("max"):
                    assert followers <= test_case["criteria"]["follower_range"]["max"]

    def test_error_handling(self, api_client):
        """测试错误处理"""
        logger.info("\n=== 测试错误处理 ===")
        
        # 测试无效的搜索条件
        invalid_cases = [
            {
                "name": "空关键词测试",
                "criteria": {
                    "keywords": [],
                    "follower_range": {"min": 1000, "max": None}
                }
            },
            {
                "name": "无效的粉丝范围测试",
                "criteria": {
                    "keywords": ["test"],
                    "follower_range": {"min": 1000, "max": 500}
                }
            }
        ]
        
        for test_case in invalid_cases:
            response = api_client.post(
                "http://localhost:8888/search-tasks",
                json={
                    "name": test_case["name"],
                    "platform": "instagram",
                    "max_users": 5,
                    "criteria": test_case["criteria"]
                }
            )
            
            assert response.status_code in [400, 422]

    def _wait_for_task_completion(self, api_client, task_id: int, timeout: int = 300):
        """等待任务完成"""
        start_time = time.time()
        while time.time() - start_time < timeout:
            response = api_client.get(f"http://localhost:8888/search-tasks/{task_id}")
            task = response.json()
            
            if task["status"] in ["completed", "failed"]:
                if task["status"] == "failed":
                    pytest.fail(f"任务执行失败: {task.get('error_message')}")
                return
            
            time.sleep(5)
        
        pytest.fail(f"任务执行超时: {timeout}秒")

if __name__ == "__main__":
    pytest.main([__file__, "-v"]) 