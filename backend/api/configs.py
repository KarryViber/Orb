from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional
import json
import logging
import os
from dotenv import load_dotenv, set_key
from pathlib import Path

from models.database import get_db
from models.models import SystemConfig
from pydantic import BaseModel

router = APIRouter(tags=["configs"])
logger = logging.getLogger(__name__)

class ConfigResponse(BaseModel):
    key: str
    value: Optional[str] = None
    description: Optional[str] = None

    class Config:
        from_attributes = True

class ConfigUpdate(BaseModel):
    value: str
    description: Optional[str] = None

@router.get("", response_model=List[ConfigResponse])
async def get_configs(db: Session = Depends(get_db)):
    """获取所有配置"""
    try:
        configs = []
        # 从数据库获取配置
        db_configs = db.query(SystemConfig).all()
        
        # 如果数据库中没有配置，则从环境变量获取
        if not db_configs:
            env_keys = ['APIFY_API_TOKEN', 'INSTAGRAM_USERNAME', 'INSTAGRAM_PASSWORD', 'INSTAGRAM_COOKIES']
            for key in env_keys:
                value = os.getenv(key)
                if value:
                    configs.append(ConfigResponse(
                        key=key,
                        value=value,
                        description=f"Environment variable: {key}"
                    ))
        else:
            for config in db_configs:
                configs.append(ConfigResponse(
                    key=config.key,
                    value=config.value,
                    description=config.description
                ))
            
        return configs
    except Exception as e:
        logger.error(f"获取配置失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{key}", response_model=ConfigResponse)
async def get_config(key: str, db: Session = Depends(get_db)):
    """获取单个配置"""
    try:
        # 从数据库获取配置
        config = db.query(SystemConfig).filter(SystemConfig.key == key).first()
        if not config:
            # 如果数据库中没有，则从环境变量获取
            value = os.getenv(key)
            if value is None:
                raise HTTPException(status_code=404, detail="配置不存在")
            return ConfigResponse(key=key, value=value)
        return ConfigResponse(
            key=config.key,
            value=config.value,
            description=config.description
        )
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"获取配置失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/{key}", response_model=ConfigResponse)
async def update_config(key: str, config_update: ConfigUpdate, db: Session = Depends(get_db)):
    """更新配置"""
    try:
        # 验证 JSON 格式
        if key == "INSTAGRAM_COOKIES" and config_update.value:
            try:
                json.loads(config_update.value)
            except json.JSONDecodeError:
                raise HTTPException(status_code=400, detail="Invalid JSON format")

        # 查找现有配置
        config = db.query(SystemConfig).filter(SystemConfig.key == key).first()
        
        if config:
            # 更新现有配置
            config.value = config_update.value
            if config_update.description:
                config.description = config_update.description
        else:
            # 创建新配置
            config = SystemConfig(
                key=key,
                value=config_update.value,
                description=config_update.description
            )
            db.add(config)
        
        # 提交更改
        db.commit()
        db.refresh(config)
        
        return ConfigResponse(
            key=config.key,
            value=config.value,
            description=config.description
        )
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"更新配置失败: {str(e)}")
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{key}")
async def delete_config(key: str, db: Session = Depends(get_db)):
    """删除配置"""
    try:
        config = db.query(SystemConfig).filter(SystemConfig.key == key).first()
        if config:
            db.delete(config)
            db.commit()
        return {"message": "配置已删除"}
    except Exception as e:
        logger.error(f"删除配置失败: {str(e)}")
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e)) 