import os
import asyncio
import logging
import threading
from datetime import datetime
from typing import Optional

from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from services.config_manager import ConfigStore
from services.chat_service import ChatService, MODEL_MAPPING
from services.process_manager import ProcessManager
import asyncio

# ---------- 日志配置 ----------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("flask_app")

app = Flask(__name__)

# ---------- 初始化 Services ----------
CONFIG_STORE_PATH = os.getenv("CONFIG_STORE_PATH") or os.path.join(os.path.dirname(__file__), "config_profiles.json")
ENV_DEFAULTS = {
    "secure_c_ses": os.getenv("SECURE_C_SES"),
    "host_c_oses": os.getenv("HOST_C_OSES"),
    "csesidx": os.getenv("CSESIDX"),
    "config_id": os.getenv("CONFIG_ID"),
    "proxy": os.getenv("PROXY") or None,
}

config_store = ConfigStore(CONFIG_STORE_PATH, env_defaults=ENV_DEFAULTS)
chat_service = ChatService(config_store)
process_manager = ProcessManager(config_store)

# 全局 EventLoop (在 run 时设置)
MAIN_LOOP: Optional[asyncio.AbstractEventLoop] = None

def get_loop():
    global MAIN_LOOP
    if MAIN_LOOP is None:
        try:
            # 尝试获取当前运行的事件循环
            MAIN_LOOP = asyncio.get_running_loop()
        except RuntimeError:
            # 如果没有运行的事件循环，创建一个新的并运行它
            MAIN_LOOP = asyncio.new_event_loop()
            # 确保事件循环不会被意外关闭
            asyncio.set_event_loop(MAIN_LOOP)
    return MAIN_LOOP

# ---------- 路由: 页面 ----------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/config")
def config_page():
    return render_template("config.html")

# ---------- 路由: 配置 API ----------
@app.route("/api/config/profiles", methods=["GET"])
async def get_profiles():
    profiles = await config_store.list_profiles()
    return jsonify([p.model_dump() for p in profiles])

@app.route("/api/config/profiles", methods=["POST"])
async def create_profile():
    data = request.json
    try:
        # 处理空字符串，转换为None
        host_c_oses = data.get("host_c_oses")
        if host_c_oses == "":
            host_c_oses = None
        
        proxy = data.get("proxy")
        if proxy == "":
            proxy = None
        
        profile = await config_store.create_profile(
            name=data["name"],
            secure_c_ses=data["secure_c_ses"],
            csesidx=data["csesidx"],
            config_id=data["config_id"],
            host_c_oses=host_c_oses,
            proxy=proxy,
        )
        return jsonify(profile.model_dump())
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/config/active", methods=["GET"])
async def get_active_profile():
    try:
        profile = await config_store.get_active_profile()
        return jsonify(profile.model_dump())
    except RuntimeError:
        return jsonify({"error": "No active profile"}), 404

@app.route("/api/config/profiles/<profile_id>/activate", methods=["POST"])
async def activate_profile(profile_id):
    try:
        profile = await config_store.set_active(profile_id)
        return jsonify(profile.model_dump())
    except KeyError:
        return jsonify({"error": "Profile not found"}), 404

@app.route("/api/config/profiles/<profile_id>", methods=["DELETE"])
async def delete_profile(profile_id):
    try:
        await config_store.delete_profile(profile_id)
        return jsonify({"ok": True})
    except KeyError:
        return jsonify({"error": "Profile not found"}), 404

@app.route("/api/config/profiles/<profile_id>", methods=["PUT"])
async def update_profile(profile_id):
    data = request.json
    try:
        # 先检查配置是否存在
        profiles = await config_store.list_profiles()
        existing_profile = next((p for p in profiles if p.id == profile_id), None)
        if not existing_profile:
            return jsonify({"error": "Profile not found"}), 404
        
        # 处理null值，确保空字符串或null被转换为None
        def get_value(key, default):
            value = data.get(key, default)
            return None if value in [None, ""] else value
        
        # 更新配置
        profile = await config_store.update_profile(
            profile_id,
            name=get_value("name", existing_profile.name),
            secure_c_ses=get_value("secure_c_ses", existing_profile.secure_c_ses),
            csesidx=get_value("csesidx", existing_profile.csesidx),
            config_id=get_value("config_id", existing_profile.config_id),
            host_c_oses=get_value("host_c_oses", existing_profile.host_c_oses),
            proxy=get_value("proxy", existing_profile.proxy),
        )
        return jsonify(profile.model_dump())
    except Exception as e:
        logger.error(f"Update profile failed: {e}")
        return jsonify({"error": str(e)}), 400

@app.route("/api/config/check_availability", methods=["POST"])
async def check_availability():
    data = request.json or {}
    profile_id = data.get("id")
    
    if profile_id:
        # Check single
        ok = await chat_service.check_profile_availability(profile_id)
        return jsonify({"id": profile_id, "valid": ok})
    else:
        # Check all
        profiles = await config_store.list_profiles()
        results = []
        for p in profiles:
            ok = await chat_service.check_profile_availability(p.id)
            results.append({"id": p.id, "valid": ok})
        return jsonify(results)

@app.route("/api/keepalive/apply", methods=["POST"])
async def keepalive_apply():
    data = request.json
    try:
        profile = await config_store.update_profile(
            data["profile_id"],
            secure_c_ses=data["secure_c_ses"],
            csesidx=data["csesidx"],
            config_id=data["config_id"],
            host_c_oses=data.get("host_c_oses"),
        )
        return jsonify(profile.model_dump())
    except Exception as e:
        logger.error(f"Keepalive apply failed: {e}")
        return jsonify({"error": str(e)}), 500

# ---------- 路由: Chat API ----------
@app.route("/v1/models", methods=["GET"])
def list_models():
    data = []
    now = int(datetime.now().timestamp())
    for m in MODEL_MAPPING.keys():
        data.append({
            "id": m,
            "object": "model",
            "created": now,
            "owned_by": "google",
            "permission": []
        })
    return jsonify({"object": "list", "data": data})

@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    req = request.json
    messages = req.get("messages", [])
    model = req.get("model", "gemini-auto")
    stream = req.get("stream", False)

    import json

    if stream:
        def generate():
            # 为当前请求创建独立的 Event Loop
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # 获取异步生成器
                async_gen = chat_service.chat_completions(messages, model, stream=True)
                
                while True:
                    try:
                        # 同步驱动异步生成器获取下一个 chunk
                        chunk = loop.run_until_complete(async_gen.__anext__())
                        yield chunk
                    except StopAsyncIteration:
                        break
                    except Exception as e:
                        logger.error(f"Stream generation error: {e}")
                        # 尝试发送错误信息给客户端
                        yield f"data: {json.dumps({'error': {'message': str(e)}})}\n\n"
                        break
            finally:
                try:
                    loop.run_until_complete(loop.shutdown_asyncgens())
                    loop.close()
                except Exception:
                    pass

        return Response(stream_with_context(generate()), content_type="text/event-stream")
        
    else:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            async def run_non_stream():
                full_content = ""
                full_reasoning = ""
                chat_id = ""
                created = 0
                async for chunk_str in chat_service.chat_completions(messages, model, stream=False):
                    if chunk_str.startswith("data: [DONE]"): break
                    if chunk_str.startswith("data: "):
                        try:
                            chunk = json.loads(chunk_str[6:])
                            if not chunk.get("choices"): continue
                            delta = chunk["choices"][0].get("delta", {})
                            if "content" in delta: full_content += delta["content"]
                            if "reasoning_content" in delta: full_reasoning += delta["reasoning_content"]
                            chat_id = chunk.get("id", "")
                            created = chunk.get("created", 0)
                        except Exception:
                            pass
                
                return {
                    "id": chat_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": full_content,
                            "reasoning_content": full_reasoning
                        },
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                }

            resp = loop.run_until_complete(run_non_stream())
            return jsonify(resp)
        except Exception as e:
            logger.error(f"Chat failed: {e}")
            return jsonify({"error": {"message": str(e)}}), 500
        finally:
            try:
                loop.close()
            except Exception:
                pass

# ---------- 路由: 进程管理 ----------
@app.route("/api/register/start", methods=["POST"])
def register_start():
    try:
        process_manager.start_register(request.json)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/register/stop", methods=["POST"])
def register_stop():
    process_manager.stop_register()
    return jsonify({"ok": True})

@app.route("/api/register/status", methods=["GET"])
def register_status():
    return jsonify(process_manager.get_register_status())

@app.route("/api/keepalive/start", methods=["POST"])
async def keepalive_start():
    # 需要获取 active profile id
    try:
        profile = await config_store.get_active_profile()
        process_manager.set_keepalive_profile_id(profile.id)
    except:
        pass # 允许无 profile 启动，但不会自动更新

    try:
        keepalive_url = f"http://127.0.0.1:{os.getenv('PORT', 7860)}/api/keepalive/apply"
        process_manager.start_keepalive(request.json, keepalive_url)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/api/keepalive/stop", methods=["POST"])
def keepalive_stop():
    process_manager.stop_keepalive()
    return jsonify({"ok": True})

@app.route("/api/keepalive/status", methods=["GET"])
def keepalive_status():
    return jsonify(process_manager.get_keepalive_status())

if __name__ == "__main__":
    # 设置 Loop 给 ProcessManager 使用
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    
    MAIN_LOOP = loop
    process_manager.set_loop(loop)
    
    # 启动 Flask
    port = int(os.getenv("PORT", 5000))
    try:
        logger.info(f"🚀 Starting Flask server on port {port}...")
        app.run(host="0.0.0.0", port=port, debug=True, use_reloader=False)
    except OSError as e:
        if getattr(e, 'winerror', 0) == 10013:
            logger.error(f"❌ 端口 {port} 被占用。请尝试设置 PORT 环境变量使用其他端口，例如: $env:PORT=5001")
        raise
