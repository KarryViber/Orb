from fastapi import APIRouter, HTTPException
import httpx
from fastapi.responses import Response
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

@router.get("/image")
async def proxy_image(url: str):
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            if response.status_code == 200:
                return Response(
                    content=response.content,
                    media_type=response.headers.get("content-type", "image/jpeg")
                )
            else:
                logger.error(f"代理图片请求失败: {url}, 状态码: {response.status_code}")
                raise HTTPException(status_code=response.status_code, detail="Failed to fetch image")
    except Exception as e:
        logger.error(f"代理图片请求出错: {url}, 错误: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) 