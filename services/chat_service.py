import json
import time
import hmac
import hashlib
import base64
import asyncio
import uuid
import ssl
import re
import logging
from typing import List, Optional, Union, Dict, Any, AsyncGenerator
from datetime import datetime
from weakref import WeakKeyDictionary

import httpx
from services.config_manager import ConfigStore
from services.streaming_parser import parse_json_array_stream_async

logger = logging.getLogger("gemini_chat")

# ---------- 配置 ----------
TIMEOUT_SECONDS = 600

# ---------- 模型映射配置 ----------
MODEL_MAPPING = {
    "gemini-auto": None,
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-3-pro-preview": "gemini-3-pro-preview"
}

def get_common_headers(jwt: str) -> dict:
    return {
        "accept": "*/*",
        "accept-encoding": "gzip, deflate, br, zstd",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "authorization": f"Bearer {jwt}",
        "content-type": "application/json",
        "origin": "https://business.gemini.google",
        "referer": "https://business.gemini.google/",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "x-server-timeout": "1800",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
    }

def urlsafe_b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")

def kq_encode(s: str) -> str:
    b = bytearray()
    for ch in s:
        v = ord(ch)
        if v > 255:
            b.append(v & 255)
            b.append(v >> 8)
        else:
            b.append(v)
    return urlsafe_b64encode(bytes(b))

def create_jwt(key_bytes: bytes, key_id: str, csesidx: str) -> str:
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT", "kid": key_id}
    payload = {
        "iss": "https://business.gemini.google",
        "aud": "https://biz-discoveryengine.googleapis.com",
        "sub": f"csesidx/{csesidx}",
        "iat": now,
        "exp": now + 300,
        "nbf": now,
    }
    header_b64  = kq_encode(json.dumps(header, separators=(",", ":")))
    payload_b64 = kq_encode(json.dumps(payload, separators=(",", ":")))
    message     = f"{header_b64}.{payload_b64}"
    sig         = hmac.new(key_bytes, message.encode(), hashlib.sha256).digest()
    return f"{message}.{urlsafe_b64encode(sig)}"

class JWTManager:
    def __init__(self, config_store: ConfigStore) -> None:
        self.jwt: str = ""
        self.expires: float = 0
        self._locks: WeakKeyDictionary = WeakKeyDictionary()
        self.config_store = config_store
        self._http_clients: WeakKeyDictionary = WeakKeyDictionary()

    def _get_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if loop not in self._locks:
            self._locks[loop] = asyncio.Lock()
        return self._locks[loop]

    async def get_client(self, proxy: Optional[str]) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        proxy_key = proxy or None
        
        # 获取当前 loop 的缓存记录
        cache = self._http_clients.get(loop, {"client": None, "proxy": None})
        
        if cache["client"] is not None and not cache["client"].is_closed and cache["proxy"] == proxy_key:
            return cache["client"]
            
        # 关闭旧客户端
        if cache["client"] is not None and not cache["client"].is_closed:
            try:
                await cache["client"].aclose()
            except Exception:
                pass
                
        # 创建新客户端
        client = httpx.AsyncClient(
            verify=False,
            http2=False,
            timeout=httpx.Timeout(TIMEOUT_SECONDS, connect=60.0),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50)
        )
        self._http_clients[loop] = {"client": client, "proxy": proxy_key}
        return client

    async def get(self) -> str:
        async with self._get_lock():
            if time.time() > self.expires:
                await self._refresh()
            return self.jwt

    async def _refresh(self, profile=None) -> None:
        # 支持传入特定的 profile 进行刷新，否则使用 active profile
        if profile is None:
            profile = await self.config_store.get_active_profile()
            
        cookie = f"__Secure-C_SES={profile.secure_c_ses}"
        if profile.host_c_oses:
            cookie += f"; __Host-C_OSES={profile.host_c_oses}"
        
        logger.debug(f"🔑 正在刷新 JWT (Profile: {profile.name})...")
        
        # 直接创建 httpx.AsyncClient，不使用 get_client 方法
        client = httpx.AsyncClient(
            verify=False,
            http2=False,
            timeout=httpx.Timeout(TIMEOUT_SECONDS, connect=60.0),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50)
        )
        
        try:
            r = await client.get(
                "https://business.gemini.google/auth/getoxsrf",
                params={"csesidx": profile.csesidx},
                headers={
                    "cookie": cookie,
                    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
                    "referer": "https://business.gemini.google/"
                },
            )
            if r.status_code != 200:
                logger.error(f"❌ getoxsrf 失败: {r.status_code} {r.text}")
                raise Exception(f"getoxsrf failed: {r.status_code}")
            
            txt = r.text[4:] if r.text.startswith(")]}'") else r.text
            data = json.loads(txt)

            key_bytes = base64.urlsafe_b64decode(data["xsrfToken"] + "==")
            new_jwt = create_jwt(key_bytes, data["keyId"], profile.csesidx)
            
            # 只有当是 active profile 时才更新实例变量
            if profile.is_active:
                self.jwt = new_jwt
                self.expires = time.time() + 270
                
            logger.info(f"✅ JWT 刷新成功 (Profile: {profile.name})")
        finally:
            # 确保客户端被关闭
            await client.aclose()

class ChatService:
    def __init__(self, config_store: ConfigStore):
        self.config_store = config_store
        self.jwt_mgr = JWTManager(config_store)
        self.session_cache: Dict[str, dict] = {}
        # 使用 WeakKeyDictionary 按 loop 隔离缓存: {loop: {proxy_key: client}}
        self._loop_clients: WeakKeyDictionary = WeakKeyDictionary()

    async def get_http_client(self, proxy: Optional[str]) -> httpx.AsyncClient:
        """获取或创建 HTTP 客户端，按当前运行的 loop 和代理缓存"""
        loop = asyncio.get_running_loop()
        # Ensure empty string is treated as None
        proxy = proxy if proxy else None
        proxy_key = proxy
        
        # 确保当前 loop 的缓存字典存在
        if loop not in self._loop_clients:
            self._loop_clients[loop] = {}
            
        loop_cache = self._loop_clients[loop]
        
        # 如果缓存中不存在或已关闭，则创建
        if proxy_key not in loop_cache or loop_cache[proxy_key].is_closed:
            # 构建客户端参数，代理参数名是 proxies 而不是 proxy
            client_kwargs = {
                "verify": False,
                "http2": False,
                "timeout": httpx.Timeout(TIMEOUT_SECONDS, connect=60.0),
                "limits": httpx.Limits(max_keepalive_connections=20, max_connections=50)
            }
            
            # 如果有代理，添加到客户端配置中
            if proxy:
                client_kwargs["proxies"] = {
                    "http://": proxy, 
                    "https://": proxy
                }
            
            loop_cache[proxy_key] = httpx.AsyncClient(**client_kwargs)
            
        return loop_cache[proxy_key]

    async def _get_session_file_metadata_async(self, session_name: str) -> Dict[str, dict]:
        """异步获取 session 中的文件元数据，返回 {fileId: meta} 映射。

        只迁移参考实现中的核心逻辑，按当前 httpx/async 架构实现。
        """
        profile = await self.config_store.get_active_profile()
        jwt = await self.jwt_mgr.get()
        headers = get_common_headers(jwt)

        client = await self.get_http_client(profile.proxy)

        body = {
            "configId": profile.config_id,
            "additionalParams": {"token": "-"},
            # 与参考实现保持一致：使用 name 字段和 AI_GENERATED 过滤
            "listSessionFileMetadataRequest": {
                "name": session_name,
                "filter": "file_origin_type = AI_GENERATED",
            },
        }

        url = "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global/widgetListSessionFileMetadata"
        r = await client.post(url, headers=headers, json=body)
        if r.status_code != 200:
            text = await r.aread()
            logger.warning(f"⚠️ widgetListSessionFileMetadata 失败: {r.status_code} {text[:200]!r}")
            return {}

        # 手动解析 JSON，兼容可能的前缀和字段名差异
        raw = await r.aread()
        try:
            txt = raw.decode("utf-8", errors="ignore")
            if txt.startswith(")]}'"):
                txt = txt[4:]
            data = json.loads(txt)
        except Exception:
            logger.warning(f"⚠️ 解析文件元数据失败: {raw[:200]!r}")
            return {}

        # 兼容 listSessionFileMetadataResponse / listSessionFileMMetadataResponse
        root = (
            data.get("listSessionFileMetadataResponse")
            or data.get("listSessionFileMMetadataResponse")
            or {}
        )

        metas: Dict[str, dict] = {}
        file_list = root.get("fileMetadata", [])
        for fm in file_list:
            fid = fm.get("fileId")
            if not fid:
                continue
            metas[fid] = fm
        return metas

    async def _download_file_with_jwt_async(self, session_name: str, file_id: str) -> bytes:
        """使用 JWT 下载文件数据（异步）。

        只用于图片 fileId -> 原始字节，不落盘，返回 bytes。
        """
        profile = await self.config_store.get_active_profile()
        jwt = await self.jwt_mgr.get()
        headers = get_common_headers(jwt)

        client = await self.get_http_client(profile.proxy)

        download_url = f"https://biz-discoveryengine.googleapis.com/v1alpha/{session_name}:downloadFile?fileId={file_id}&alt=media"
        r = await client.get(download_url, headers=headers, follow_redirects=True)

        if r.status_code == 401:
            try:
                await self.jwt_mgr._refresh(profile)  # 刷新 JWT 后重试一次
                jwt = await self.jwt_mgr.get()
                headers = get_common_headers(jwt)
                r = await client.get(download_url, headers=headers, follow_redirects=True)
            except Exception:
                pass

        if r.status_code == 401:
            data = await self._download_file_with_cookie_async(download_url, profile)
            if data:
                return data

        if r.status_code != 200:
            blob = await r.aread()
            logger.warning(f"⚠️ downloadFile 失败: {r.status_code} {blob[:200]!r}")
            return b""

        # 读取内容，并检测是否为 base64 文本（参考正确核心借鉴实现）
        content = await r.aread()

        try:
            text_content = content.decode("utf-8", errors="ignore").strip()
            # PNG base64 以 iVBORw0KGgo 开头，JPEG 以 /9j/ 开头
            if text_content.startswith("iVBORw0KGgo") or text_content.startswith("/9j/"):
                try:
                    return base64.b64decode(text_content)
                except Exception as dec_err:
                    logger.warning(f"⚠️ base64 解码下载图片失败: {dec_err}")
        except Exception:
            # 不是文本或解码失败，直接返回原始内容
            pass

        return content

    async def _download_file_with_cookie_async(self, download_url: str, profile) -> bytes:
        secure_c_ses = profile.secure_c_ses
        host_c_oses = profile.host_c_oses

        cookie_str = f"__Secure-C_SES={secure_c_ses}"
        if host_c_oses:
            cookie_str += f"; __Host-C_OSES={host_c_oses}"

        client = await self.get_http_client(profile.proxy)
        r = await client.get(
            download_url,
            headers={
                "cookie": cookie_str,
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
            },
            follow_redirects=True,
        )

        if r.status_code != 200:
            blob = await r.aread()
            logger.warning(f"⚠️ downloadFile(cookie) 失败: {r.status_code} {blob[:200]!r}")
            return b""

        return await r.aread()

    async def check_profile_availability(self, profile_id: str) -> bool:
        try:
            logger.info(f"Starting availability check for profile {profile_id}")
            
            # 获取指定 profile
            profiles = await self.config_store.list_profiles()
            target = next((p for p in profiles if p.id == profile_id), None)
            if not target:
                logger.error(f"Profile {profile_id} not found")
                return False
            
            logger.info(f"Profile {profile_id} found: {target.name}")
            
            # 检查配置是否完整
            if not all([target.secure_c_ses, target.csesidx, target.config_id]):
                logger.warning(f"Profile {profile_id} missing required fields")
                await self.config_store.update_profile(
                    profile_id, 
                    status="Invalid", 
                    last_checked=int(time.time())
                )
                return False
            
            # 尝试使用与参考代码一致的方式检查可用性
            # 直接发送请求检查凭据是否有效，而不是依赖 JWTManager
            cookie = f"__Secure-C_SES={target.secure_c_ses}"
            if target.host_c_oses:
                cookie += f"; __Host-C_OSES={target.host_c_oses}"
            
            logger.info(f"Cookie: {cookie[:50]}...")
            logger.info(f"CSESIDX: {target.csesidx}")
            
            # 直接创建 HTTP 客户端，不使用缓存
            logger.info(f"Creating HTTP client, proxy: {target.proxy or 'None'}")
            client = await self.get_http_client(target.proxy)
            
            # 发送请求检查凭据是否有效
            logger.info(f"Sending GET request to https://business.gemini.google/auth/getoxsrf")
            r = await client.get(
                "https://business.gemini.google/auth/getoxsrf",
                params={"csesidx": target.csesidx},
                headers={
                    "cookie": cookie,
                    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
                    "referer": "https://business.gemini.google/"
                },
            )
            
            logger.info(f"Response status: {r.status_code}")
            logger.info(f"Response headers: {dict(r.headers)}")
            logger.info(f"Response text: {r.text[:100]}...")
            
            if r.status_code != 200:
                logger.error(f"Profile {profile_id} check failed: getoxsrf returned {r.status_code}")
                await self.config_store.update_profile(
                    profile_id, 
                    status="Invalid", 
                    last_checked=int(time.time())
                )
                return False
            
            # 解析响应
            txt = r.text[4:] if r.text.startswith(")]}'") else r.text
            logger.info(f"Parsed response text: {txt[:100]}...")
            data = json.loads(txt)
            
            logger.info(f"Parsed JSON data: {data}")
            
            # 检查响应是否包含必需的字段
            if not all(["xsrfToken" in data, "keyId" in data]):
                logger.error(f"Profile {profile_id} check failed: invalid response format")
                await self.config_store.update_profile(
                    profile_id, 
                    status="Invalid", 
                    last_checked=int(time.time())
                )
                return False
            
            logger.info(f"Profile {profile_id} is valid, updating status")
            
            # 更新状态
            await self.config_store.update_profile(
                profile_id, 
                    status="Valid", 
                    last_checked=int(time.time())
            )
            return True
        except Exception as e:
            logger.error(f"Profile {profile_id} check failed with exception: {e}", exc_info=True)
            try:
                await self.config_store.update_profile(
                    profile_id, 
                    status="Invalid", 
                    last_checked=int(time.time())
                )
            except Exception as update_exc:
                logger.error(f"Failed to update profile status: {update_exc}")
            return False

    async def create_google_session(self) -> str:
        profile = await self.config_store.get_active_profile()
        jwt = await self.jwt_mgr.get()
        headers = get_common_headers(jwt)
        body = {
            "configId": profile.config_id,
            "additionalParams": {"token": "-"},
            "createSessionRequest": {
                "session": {"name": "", "displayName": ""}
            }
        }
        
        logger.debug("🌐 申请新 Session...")
        client = await self.get_http_client(profile.proxy)
        r = await client.post(
            "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global/widgetCreateSession",
            headers=headers,
            json=body,
        )
        if r.status_code != 200:
            logger.error(f"❌ createSession 失败: {r.status_code} {r.text}")
            raise Exception(f"createSession failed: {r.status_code}")
        sess_name = r.json()["session"]["name"]
        return sess_name

    async def upload_context_file(self, session_name: str, mime_type: str, base64_content: str) -> str:
        jwt = await self.jwt_mgr.get()
        headers = get_common_headers(jwt)
        profile = await self.config_store.get_active_profile()
        
        ext = mime_type.split('/')[-1] if '/' in mime_type else "bin"
        file_name = f"upload_{int(time.time())}_{uuid.uuid4().hex[:6]}.{ext}"

        body = {
            "configId": profile.config_id,
            "additionalParams": {"token": "-"},
            "addContextFileRequest": {
                "name": session_name,
                "fileName": file_name,
                "mimeType": mime_type,
                "fileContents": base64_content
            }
        }

        logger.info(f"📤 上传图片 [{mime_type}] 到 Session...")
        client = await self.get_http_client(profile.proxy)
        r = await client.post(
            "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global/widgetAddContextFile",
            headers=headers,
            json=body,
        )

        if r.status_code != 200:
            logger.error(f"❌ 上传文件失败: {r.status_code} {r.text}")
            raise Exception(f"Upload failed: {r.text}")
        
        data = r.json()
        file_id = data.get("addContextFileResponse", {}).get("fileId")
        logger.info(f"✅ 图片上传成功, ID: {file_id}")
        return file_id

    async def stream_chat_generator(
        self, 
        session: str, 
        text_content: str, 
        file_ids: List[str], 
        model_name: str, 
        chat_id: str, 
        created_time: int, 
        is_stream: bool = True
    ) -> AsyncGenerator[str, None]:
        start_time = time.time()
        profile = await self.config_store.get_active_profile()
        jwt = await self.jwt_mgr.get()
        headers = get_common_headers(jwt)

        body = {
            "configId": profile.config_id,
            "additionalParams": {"token": "-"},
            "streamAssistRequest": {
                "session": session,
                "query": {"parts": [{"text": text_content}]},
                "filter": "",
                "fileIds": file_ids,
                "answerGenerationMode": "NORMAL",
                "toolsSpec": {
                    "webGroundingSpec": {},
                    "toolRegistry": "default_tool_registry",
                    "imageGenerationSpec": {},
                    "videoGenerationSpec": {}
                },
                "languageCode": "zh-CN",
                "userMetadata": {"timeZone": "Asia/Shanghai"},
                "assistSkippingMode": "REQUEST_ASSIST"
            }
        }

        target_model_id = MODEL_MAPPING.get(model_name)
        if target_model_id:
            body["streamAssistRequest"]["assistGenerationConfig"] = {
                "modelId": target_model_id
            }

        def create_chunk(id: str, created: int, model: str, delta: dict, finish_reason: Union[str, None]) -> str:
            chunk = {
                "id": id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finish_reason
                }]
            }
            return json.dumps(chunk)

        if is_stream:
            chunk = create_chunk(chat_id, created_time, model_name, {"role": "assistant"}, None)
            yield f"data: {chunk}\n\n"

        client = await self.get_http_client(profile.proxy)
        
        # 使用与参考代码一致的方式处理响应
        r = await client.post(
            "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global/widgetStreamAssist",
            headers=headers,
            json=body,
        )
        
        if r.status_code != 200:
            error_text = await r.aread()
            raise Exception(f"Upstream Error {error_text.decode()}")

        try:
            def _emit_image_from_url(url: str):
                if not url:
                    return None
                # URL
                if isinstance(url, str) and url.startswith("http"):
                    if "lh3.googleusercontent.com" not in url and "/d/" in url:
                        # file_id URL
                        file_id = url.split("/d/")[-1].split("?")[0]
                        url = f"https://lh3.googleusercontent.com/d/{file_id}"

                img_md = f"\n![Generated Image]({url})\n"
                chunk = create_chunk(chat_id, created_time, model_name, {"content": img_md}, None)
                return f"data: {chunk}\n\n"

            def _emit_from_generated_image(gen_img: dict):
                if not isinstance(gen_img, dict):
                    return None

                img_data = gen_img.get("image", {}) or {}

                b64_data = (
                    img_data.get("imageBytes")
                    or img_data.get("data")
                    or img_data.get("bytesBase64Encoded")
                    or gen_img.get("imageBytes")
                    or gen_img.get("bytesBase64Encoded")
                )

                url = (
                    img_data.get("uri")
                    or img_data.get("imageUrl")
                    or img_data.get("url")
                    or gen_img.get("uri")
                    or gen_img.get("imageUrl")
                    or gen_img.get("url")
                )

                mime = img_data.get("mimeType") or gen_img.get("mimeType", "image/png")

                if b64_data and not url:
                    url = f"data:{mime};base64,{b64_data}"

                return _emit_image_from_url(url)

            def _emit_from_content_images(content: dict):
                chunks: List[str] = []
                if not isinstance(content, dict):
                    return chunks

                inline_data = content.get("inlineData")
                if inline_data:
                    b64_data = inline_data.get("data")
                    if b64_data:
                        mime = inline_data.get("mimeType", "image/png")
                        data_url = f"data:{mime};base64,{b64_data}"
                        out = _emit_image_from_url(data_url)
                        if out:
                            chunks.append(out)

                image_url = content.get("imageUrl") or content.get("uri") or content.get("url")
                if image_url:
                    out = _emit_image_from_url(image_url)
                    if out:
                        chunks.append(out)

                parts = content.get("parts") or []
                for part in parts:
                    if not isinstance(part, dict):
                        continue
                    p_inline = part.get("inlineData")
                    if p_inline:
                        b64_data = p_inline.get("data")
                        if b64_data:
                            mime = p_inline.get("mimeType", "image/png")
                            data_url = f"data:{mime};base64,{b64_data}"
                            out = _emit_image_from_url(data_url)
                            if out:
                                chunks.append(out)

                    p_url = (
                        part.get("imageUrl")
                        or part.get("uri")
                        or part.get("fileData", {}).get("fileUri")
                    )
                    if p_url:
                        out = _emit_image_from_url(p_url)
                        if out:
                            chunks.append(out)

                return chunks

            def _emit_from_attachment(att: dict):
                if not isinstance(att, dict):
                    return None

                mime_type = att.get("mimeType", "")
                if not mime_type.startswith("image/"):
                    return None

                b64_data = (
                    att.get("data")
                    or att.get("bytesBase64Encoded")
                    or att.get("imageBytes")
                )
                url = att.get("uri") or att.get("url") or att.get("imageUrl")

                if b64_data and not url:
                    url = f"data:{mime_type};base64,{b64_data}"

                return _emit_image_from_url(url)

            # JSON 
            current_session_name: Optional[str] = None
            pending_file_ids: List[Dict[str, str]] = []

            async for data in parse_json_array_stream_async(r.aiter_lines()):
                sar = data.get("streamAssistResponse", {}) or {}

                # 如果本条里带有 sessionInfo，则更新当前 session
                sess_info = sar.get("sessionInfo", {}) or {}
                if sess_info.get("session"):
                    current_session_name = sess_info["session"]

                # generatedImages
                top_gen_images = sar.get("generatedImages") or []
                for gen_img in top_gen_images:
                    out = _emit_from_generated_image(gen_img)
                    if out:
                        yield out

                answer = sar.get("answer") or {}

                # answer generatedImages
                answer_gen_images = answer.get("generatedImages") or []
                for gen_img in answer_gen_images:
                    out = _emit_from_generated_image(gen_img)
                    if out:
                        yield out

                for reply in answer.get("replies", []) or []:
                    # Log the full reply for debugging image generation
                    if "image" in str(reply).lower() or "nano" in str(reply).lower():
                        logger.info(f" Reply Debug: {json.dumps(reply, ensure_ascii=False)}")

                    grounded = reply.get("groundedContent", {}) or {}
                    content_obj = grounded.get("content", {}) or {}
                    text = content_obj.get("text", "")

                    # 收集 fileId，参考 biz_gemini.BizGeminiClient.chat_full
                    file_info = content_obj.get("file") or {}
                    if file_info.get("fileId"):
                        pending_file_ids.append({
                            "fileId": file_info["fileId"],
                            "mimeType": file_info.get("mimeType", "image/png"),
                        })

                    # 
                    if content_obj.get("thought") and text:
                        chunk = create_chunk(chat_id, created_time, model_name, {"reasoning_content": text}, None)
                        yield f"data: {chunk}\n\n"
                    elif text:  # 
                        chunk = create_chunk(chat_id, created_time, model_name, {"content": text}, None)
                        yield f"data: {chunk}\n\n"

                    # 
                    # reply generatedImages
                    reply_gen_images = reply.get("generatedImages") or []
                    for gen_img in reply_gen_images:
                        out = _emit_from_generated_image(gen_img)
                        if out:
                            yield out

                    # imageGeneration 
                    image_gen = reply.get("imageGeneration") or {}
                    for img in image_gen.get("images") or []:
                        out = _emit_from_generated_image(img)
                        if out:
                            yield out

                    # groundedContent / content 
                    for out in _emit_from_content_images(content_obj):
                        yield out
                    for out in _emit_from_content_images(grounded):
                        yield out

                    # attachments 
                    attachments = (
                        reply.get("attachments")
                        or grounded.get("attachments")
                        or content_obj.get("attachments")
                        or []
                    )
                    for att in attachments:
                        out = _emit_from_attachment(att)
                        if out:
                            yield out

            # 在流结束后统一处理 fileId 对应的图片
            if pending_file_ids and current_session_name:
                try:
                    meta_map = await self._get_session_file_metadata_async(current_session_name)
                    for finfo in pending_file_ids:
                        fid = finfo.get("fileId")
                        mime = finfo.get("mimeType", "image/png")
                        if not fid:
                            continue
                        meta = meta_map.get(fid)
                        if not meta:
                            logger.warning(f"⚠️ fileId {fid} 在元数据中不存在，跳过下载")
                            continue
                        session_path = meta.get("session") or current_session_name
                        if not session_path:
                            logger.warning(f"⚠️ fileId {fid} 缺少 session 信息，跳过下载")
                            continue
                        try:
                            img_bytes = await self._download_file_with_jwt_async(session_path, fid)
                            if img_bytes:
                                b64_data = base64.b64encode(img_bytes).decode("utf-8")
                                data_url = f"data:{mime};base64,{b64_data}"
                                out = _emit_image_from_url(data_url)
                                if out:
                                    yield out
                        except Exception as file_err:
                            logger.warning(f"⚠️ 下载 fileId 图片失败: {file_err}")
                except Exception as meta_err:
                    logger.warning(f"⚠️ 获取 fileId 元数据失败: {meta_err}")
        except Exception as e:
                logger.error(f"  : {e}")
                raise Exception(f"Stream Parse Error: {e}")

        total_time = time.time() - start_time
        logger.info(f" 完整响应耗时: {total_time:.2f}")

        if is_stream:
            final_chunk = create_chunk(chat_id, created_time, model_name, {}, "stop")
            yield f"data: {final_chunk}\n\n"
            yield "data: [DONE]\n\n"

    def parse_last_message(self, messages: List[dict]):
        if not messages:
            return "", []
        
        last_msg = messages[-1]
        content = last_msg.get("content")
        
        text_content = ""
        images = []

        if isinstance(content, str):
            text_content = content
        elif isinstance(content, list):
            for part in content:
                if part.get("type") == "text":
                    text_content += part.get("text", "")
                elif part.get("type") == "image_url":
                    url = part.get("image_url", {}).get("url", "")
                    match = re.match(r"data:(image/[^;]+);base64,(.+)", url)
                    if match:
                        images.append({"mime": match.group(1), "data": match.group(2)})

        return text_content, images

    def build_full_context_text(self, messages: List[dict]) -> str:
        prompt = ""
        for msg in messages:
            role = "User" if msg.get("role") in ["user", "system"] else "Assistant"
            content_str = ""
            content = msg.get("content")
            if isinstance(content, str):
                content_str = content
            elif isinstance(content, list):
                for part in content:
                    if part.get("type") == "text":
                        content_str += part.get("text", "")
                    elif part.get("type") == "image_url":
                        content_str += "[图片]"
            prompt += f"{role}: {content_str}\n\n"
        return prompt

    def get_conversation_key(self, messages: List[dict]) -> str:
        if not messages: return "empty"
        first_msg = messages[0].copy()
        if isinstance(first_msg.get("content"), list):
            text_part = "".join([x["text"] for x in first_msg["content"] if x.get("type") == "text"])
            first_msg["content"] = text_part
        
        key_str = json.dumps(first_msg, sort_keys=True)
        return hashlib.md5(key_str.encode()).hexdigest()

    async def chat_completions(self, messages: List[dict], model: str, stream: bool = False) -> AsyncGenerator[str, None]:
        if model not in MODEL_MAPPING:
            raise ValueError(f"Model '{model}' not found.")

        # 1. 解析请求内容
        last_text, current_images = self.parse_last_message(messages)
        
        # 2. 锚定 Session
        conv_key = self.get_conversation_key(messages)
        cached = self.session_cache.get(conv_key)
        
        if cached:
            google_session = cached["session_id"]
            text_to_send = last_text
            logger.info(f"♻️ 延续旧对话 [{model}]: {google_session[-12:]}")
            self.session_cache[conv_key]["updated_at"] = time.time()
            is_retry_mode = False
        else:
            logger.info(f"🆕 开启新对话 [{model}]")
            google_session = await self.create_google_session()
            # 新对话使用全量文本上下文 (图片只传当前的)
            text_to_send = self.build_full_context_text(messages)
            self.session_cache[conv_key] = {"session_id": google_session, "updated_at": time.time()}
            is_retry_mode = True

        chat_id = f"chatcmpl-{uuid.uuid4()}"
        created_time = int(time.time())

        # 封装生成器 (含图片上传和重试逻辑)
        async def response_wrapper():
            retry_count = 0
            max_retries = 2
            
            current_text = text_to_send
            current_retry_mode = is_retry_mode
            
            # 图片 ID 列表 (每次 Session 变化都需要重新上传，因为 fileId 绑定在 Session 上)
            current_file_ids = []

            while retry_count <= max_retries:
                try:
                    current_session = self.session_cache[conv_key]["session_id"]
                    
                    # A. 如果有图片且还没上传到当前 Session，先上传
                    # 注意：每次重试如果是新 Session，都需要重新上传图片
                    if current_images and not current_file_ids:
                        for img in current_images:
                            fid = await self.upload_context_file(current_session, img["mime"], img["data"])
                            current_file_ids.append(fid)

                    # B. 准备文本 (重试模式下发全文)
                    if current_retry_mode:
                        current_text = self.build_full_context_text(messages)

                    # C. 发起对话
                    async for chunk in self.stream_chat_generator(
                        current_session, 
                        current_text, 
                        current_file_ids, 
                        model, 
                        chat_id, 
                        created_time, 
                        stream
                    ):
                        yield chunk
                    break 

                except (httpx.ConnectError, httpx.ReadTimeout, ssl.SSLError, Exception) as e:
                    retry_count += 1
                    logger.warning(f"⚠️ 请求异常 (重试 {retry_count}/{max_retries}): {e}")

                    if retry_count <= max_retries:
                        logger.info("🔄 尝试重建 Session...")
                        try:
                            new_sess = await self.create_google_session()
                            self.session_cache[conv_key] = {"session_id": new_sess, "updated_at": time.time()}
                            current_retry_mode = True 
                            current_file_ids = [] # 清空 ID，强制下次循环重新上传到新 Session
                        except Exception as create_err:
                            logger.error(f"❌ 重建失败: {create_err}")
                            if stream:
                                yield f"data: {json.dumps({'error': {'message': 'Session Recovery Failed'}})}\n\n"
                            else:
                                yield json.dumps({'error': {'message': 'Session Recovery Failed'}})
                            return
                    else:
                        if stream:
                            yield f"data: {json.dumps({'error': {'message': f'Final Error: {e}'}})}\n\n"
                        else:
                            yield json.dumps({'error': {'message': f'Final Error: {e}'}})
                        return

        # 委托给 response_wrapper 处理
        async for chunk in response_wrapper():
            yield chunk