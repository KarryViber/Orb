from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import List, Optional
from datetime import datetime
import logging

from models.database import get_db
from models.template import MessageTemplate
from schemas.template import TemplateCreate, TemplateUpdate, TemplateResponse
from schemas.common import PaginatedResponse
from models.models import Platform
from pydantic import BaseModel

router = APIRouter(tags=["templates"])
logger = logging.getLogger(__name__)

class TemplateResponse(BaseModel):
    id: int
    name: str
    content: str
    variables: List[str]
    platform: Platform
    is_default: bool
    is_active: bool
    created_by: Optional[str] = None
    created_at: str
    updated_at: Optional[str] = None

    class Config:
        from_attributes = True

@router.get("", response_model=dict)
async def get_templates(
    keyword: Optional[str] = None,
    platform: Optional[Platform] = None,
    page: int = 1,
    pageSize: int = 10,
    db: Session = Depends(get_db)
):
    """获取模板列表"""
    try:
        logger.info("开始获取模板列表")
        query = db.query(MessageTemplate)
        
        # 关键词搜索
        if keyword:
            query = query.filter(MessageTemplate.name.ilike(f"%{keyword}%"))
        
        # 平台筛选
        if platform:
            query = query.filter(MessageTemplate.platform == platform)
        
        # 计算总数
        total = query.count()
        logger.info(f"找到 {total} 个模板")
        
        # 分页
        templates = query.offset((page - 1) * pageSize).limit(pageSize).all()
        
        # 转换为响应格式
        response_templates = []
        for template in templates:
            try:
                response_template = {
                    "id": template.id,
                    "name": template.name,
                    "content": template.content,
                    "variables": template.variables or [],
                    "platform": template.platform,
                    "is_default": template.is_default,
                    "is_active": template.is_active,
                    "created_by": template.created_by,
                    "created_at": template.created_at.isoformat() if template.created_at else None,
                    "updated_at": template.updated_at.isoformat() if template.updated_at else None
                }
                logger.info(f"处理模板数据: {response_template}")
                response_templates.append(response_template)
            except Exception as e:
                logger.error(f"处理模板 {template.id} 时出错: {str(e)}")
                continue
        
        response = {
            "code": 200,
            "message": "获取模板列表成功",
            "data": response_templates
        }
        
        logger.info(f"返回响应数据: {response}")
        return response
        
    except Exception as e:
        logger.error(f"获取模板列表失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{template_id}", response_model=dict)
async def get_template(template_id: int, db: Session = Depends(get_db)):
    """获取单个模板"""
    try:
        template = db.query(MessageTemplate).filter(MessageTemplate.id == template_id).first()
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")
            
        # 构造标准响应格式
        response = {
            "data": {
                "id": template.id,
                "name": template.name,
                "content": template.content,
                "variables": template.variables or [],
                "platform": template.platform,
                "is_default": template.is_default,
                "is_active": template.is_active,
                "created_by": template.created_by,
                "created_at": template.created_at.isoformat() if template.created_at else None,
                "updated_at": template.updated_at.isoformat() if template.updated_at else None
            }
        }
        
        return response
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"获取模板失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("", response_model=dict)
async def create_template(template: TemplateCreate, db: Session = Depends(get_db)):
    """创建模板"""
    try:
        # 如果设置为默认模板，需要将其他同平台的默认模板取消默认状态
        if template.is_default:
            db.query(MessageTemplate).filter(
                MessageTemplate.platform == template.platform,
                MessageTemplate.is_default == True
            ).update({"is_default": False})
        
        # 使用 dict() 而不是 model_dump()
        db_template = MessageTemplate(**template.dict())
        db.add(db_template)
        db.commit()
        db.refresh(db_template)
        
        # 构造响应数据
        response = {
            "data": {
                "id": db_template.id,
                "name": db_template.name,
                "content": db_template.content,
                "variables": db_template.variables or [],
                "platform": db_template.platform,
                "is_default": db_template.is_default,
                "is_active": db_template.is_active,
                "created_by": db_template.created_by,
                "created_at": db_template.created_at.isoformat() if db_template.created_at else None,
                "updated_at": db_template.updated_at.isoformat() if db_template.updated_at else None
            }
        }
        
        return response
    except Exception as e:
        logger.error(f"创建模板失败: {str(e)}")
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"创建模板失败: {str(e)}"
        )

@router.put("/{template_id}", response_model=dict)
async def update_template(
    template_id: int,
    template: TemplateUpdate,
    db: Session = Depends(get_db)
):
    """更新模板"""
    try:
        db_template = db.query(MessageTemplate).filter(MessageTemplate.id == template_id).first()
        if not db_template:
            raise HTTPException(status_code=404, detail="Template not found")
        
        # 如果设置为默认模板，需要将其他同平台的默认模板取消默认状态
        if template.is_default:
            db.query(MessageTemplate).filter(
                MessageTemplate.platform == db_template.platform,
                MessageTemplate.is_default == True,
                MessageTemplate.id != template_id
            ).update({"is_default": False})
        
        # 更新模板
        template_data = template.dict(exclude_unset=True)
        for key, value in template_data.items():
            setattr(db_template, key, value)
        
        # 更新时间戳
        db_template.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(db_template)
        
        # 构造响应数据
        response = {
            "data": {
                "id": db_template.id,
                "name": db_template.name,
                "content": db_template.content,
                "variables": db_template.variables or [],
                "platform": db_template.platform,
                "is_default": db_template.is_default,
                "is_active": db_template.is_active,
                "created_by": db_template.created_by,
                "created_at": db_template.created_at.isoformat() if db_template.created_at else None,
                "updated_at": db_template.updated_at.isoformat() if db_template.updated_at else None
            }
        }
        
        return response
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"更新模板失败: {str(e)}")
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"更新模板失败: {str(e)}"
        )

@router.delete("/{template_id}")
async def delete_template(template_id: int, db: Session = Depends(get_db)):
    """删除模板"""
    db_template = db.query(MessageTemplate).filter(MessageTemplate.id == template_id).first()
    if not db_template:
        raise HTTPException(status_code=404, detail="Template not found")
    
    db.delete(db_template)
    db.commit()
    return {"message": "Template deleted"}

@router.put("/{template_id}/default")
async def set_default_template(template_id: int, db: Session = Depends(get_db)):
    """设置默认模板"""
    try:
        db_template = db.query(MessageTemplate).filter(MessageTemplate.id == template_id).first()
        if not db_template:
            raise HTTPException(status_code=404, detail="模板不存在")
        
        # 将其他默认模板取消
        db.query(MessageTemplate).filter(
            MessageTemplate.platform == db_template.platform,
            MessageTemplate.is_default == True
        ).update({"is_default": False})
        
        # 设置新的默认模板
        db_template.is_default = True
        db_template.updated_at = datetime.utcnow()
        db.commit()
        
        return {"message": "已设置为默认模板"}
    except HTTPException as e:
        raise e
    except Exception as e:
        logger.error(f"设置默认模板失败: {str(e)}")
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"设置默认模板失败: {str(e)}"
        ) 