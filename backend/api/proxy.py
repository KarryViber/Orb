from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
import httpx
import logging
from typing import Optional
from urllib.parse import urlparse

router = APIRouter(tags=["proxy"])
logger = logging.getLogger(__name__)

ALLOWED_DOMAINS = [
    'scontent-sea1-1.cdninstagram.com',
    'scontent-atl3-1.cdninstagram.com',
    'scontent-lga3-2.cdninstagram.com',
    'scontent-man2-1.cdninstagram.com',
    'scontent-dfw5-2.cdninstagram.com',
    'scontent.cdninstagram.com',
    'instagram.fmnl13-1.fna.fbcdn.net',
    'instagram.fagc3-1.fna.fbcdn.net',
    'instagram.fagr1-3.fna.fbcdn.net',
    'instagram.fman4-2.fna.fbcdn.net',
    'scontent-jnb2-1.cdninstagram.com',
    'scontent-msp1-1.cdninstagram.com',
    'scontent-mia3-3.cdninstagram.com',
    'scontent-iad3-2.cdninstagram.com',
    'scontent-ort2-2.cdninstagram.com',
    'scontent-sin6-2.cdninstagram.com',
    'scontent-hkg4-1.cdninstagram.com',
    'scontent-nrt1-1.cdninstagram.com',
    'scontent-hkg4-2.cdninstagram.com',
    'scontent-tpe1-1.cdninstagram.com',
    'scontent-kul2-1.cdninstagram.com',
    'scontent-sin6-1.cdninstagram.com',
    'scontent-hkt1-1.cdninstagram.com',
    'scontent-icn1-1.cdninstagram.com',
    'scontent-gmp1-1.cdninstagram.com',
    'scontent-ssn1-1.cdninstagram.com',
    'scontent-itm1-1.cdninstagram.com',
    'scontent-kix1-1.cdninstagram.com',
    'scontent-frt3-1.cdninstagram.com',
    'scontent-frt3-2.cdninstagram.com',
    'scontent-ams4-1.cdninstagram.com',
    'scontent-arn2-1.cdninstagram.com',
    'scontent-bru2-1.cdninstagram.com',
    'scontent-cdg2-1.cdninstagram.com',
    'scontent-cdt1-1.cdninstagram.com',
    'scontent-dus1-1.cdninstagram.com',
    'scontent-fco1-1.cdninstagram.com',
    'scontent-frx5-1.cdninstagram.com',
    'scontent-ham3-1.cdninstagram.com',
    'scontent-lhr8-1.cdninstagram.com',
    'scontent-mad1-1.cdninstagram.com',
    'scontent-mxp1-1.cdninstagram.com',
    'scontent-waw1-1.cdninstagram.com',
    'scontent-yyz1-1.cdninstagram.com',
    'scontent-lax3-1.cdninstagram.com',
    'scontent-lax3-2.cdninstagram.com',
    'scontent-sjc3-1.cdninstagram.com',
    'scontent-syd2-1.cdninstagram.com',
    'scontent-mel1-1.cdninstagram.com',
    'scontent-bne1-1.cdninstagram.com',
    'scontent-per1-1.cdninstagram.com',
    'scontent-akl1-1.cdninstagram.com',
    'scontent-wlg1-1.cdninstagram.com',
    'scontent-gru2-1.cdninstagram.com',
    'scontent-gru2-2.cdninstagram.com',
    'scontent-scl1-1.cdninstagram.com',
    'scontent-bog1-1.cdninstagram.com',
    'scontent-lim1-1.cdninstagram.com',
    'scontent-mct1-1.cdninstagram.com',
    'scontent-dub4-1.cdninstagram.com',
    'scontent-mrs2-1.cdninstagram.com',
    'scontent-mrs2-2.cdninstagram.com',
    'scontent-vie1-1.cdninstagram.com',
    'scontent-prg1-1.cdninstagram.com',
    'scontent-waw1-1.cdninstagram.com',
    'scontent-sof1-1.cdninstagram.com',
    'scontent-bud2-1.cdninstagram.com',
    'scontent-otp1-1.cdninstagram.com',
    'scontent-arn2-2.cdninstagram.com',
    'scontent-arn2-1.cdninstagram.com',
    'scontent-hel3-1.cdninstagram.com',
    'scontent-cph2-1.cdninstagram.com',
    'scontent-ams4-2.cdninstagram.com',
    'scontent-ams4-1.cdninstagram.com',
    'scontent-bru2-1.cdninstagram.com',
    'scontent-cdg2-1.cdninstagram.com',
    'scontent-cdt1-1.cdninstagram.com',
    'scontent-dus1-1.cdninstagram.com',
    'scontent-fco1-1.cdninstagram.com',
    'scontent-frx5-1.cdninstagram.com',
    'scontent-ham3-1.cdninstagram.com',
    'scontent-lhr8-1.cdninstagram.com',
    'scontent-mad1-1.cdninstagram.com',
    'scontent-mxp1-1.cdninstagram.com',
    'scontent-waw1-1.cdninstagram.com',
    'scontent-yyz1-1.cdninstagram.com',
    'scontent-ord5-2.cdninstagram.com',
    'instagram.fsan1-2.fna.fbcdn.net',
    'instagram.ffab1-2.fna.fbcdn.net',
    'instagram.faru4-2.fna.fbcdn.net',
    'scontent-gru1-2.cdninstagram.com',
    'scontent-lga3-3.cdninstagram.com'
]

@router.get("/image")
async def proxy_image(url: str):
    """代理获取图片"""
    try:
        logger.info(f"代理请求图片: {url}")
        
        # 验证URL
        parsed_url = urlparse(url)
        if parsed_url.netloc not in ALLOWED_DOMAINS:
            logger.error(f"不允许的域名: {parsed_url.netloc}")
            raise HTTPException(status_code=403, detail="不允许的域名")
        
        # 设置请求头
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.instagram.com/"
        }
        
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url, headers=headers)
            
            if response.status_code == 200:
                # 验证内容类型
                content_type = response.headers.get("content-type", "")
                if not content_type.startswith("image/"):
                    logger.error(f"非图片类型: {content_type}")
                    raise HTTPException(status_code=400, detail="非图片类型")
                
                # 返回图片数据
                return Response(
                    content=response.content,
                    media_type=content_type,
                    headers={
                        "Cache-Control": "public, max-age=31536000",
                        "Access-Control-Allow-Origin": "*"
                    }
                )
            else:
                logger.error(f"获取图片失败: {response.status_code}")
                raise HTTPException(status_code=response.status_code, detail="获取图片失败")
                
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"代理图片请求失败: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e)) 