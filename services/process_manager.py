import subprocess
import threading
import time
import os
import asyncio
import logging
from typing import Dict, Any, List, Optional
from services.config_manager import ConfigStore

logger = logging.getLogger("process_manager")

class ProcessManager:
    def __init__(self, config_store: ConfigStore):
        self.config_store = config_store
        # Register Process State
        self.register_proc = None
        self.register_logs: List[Dict[str, Any]] = []
        self.register_status: Dict[str, Any] = {"running": False, "exit_code": None, "started_at": None}
        self.register_lock = threading.Lock()

        # Keepalive Process State
        self.keepalive_proc = None
        self.keepalive_logs: List[Dict[str, Any]] = []
        self.keepalive_status: Dict[str, Any] = {"running": False, "exit_code": None, "started_at": None}
        self.keepalive_lock = threading.Lock()
        self.keepalive_data_dir: Optional[str] = None
        self.keepalive_profile_id: Optional[str] = None
        self.loop = None

    def set_loop(self, loop):
        self.loop = loop

    # ---------- Helper Methods ----------
    def _append_log(self, logs_list: list, lock: threading.Lock, line: str):
        if not line: return
        ts = int(time.time() * 1000)
        with lock:
            logs_list.append({"time": ts, "line": line})
            if len(logs_list) > 500:
                del logs_list[:-500]

    def _reader_thread(self, stream, logs_list, lock, prefix=""):
        try:
            for raw in iter(stream.readline, ""):
                line = raw.rstrip("\n")
                if prefix:
                    line = prefix + line
                self._append_log(logs_list, lock, line)
        finally:
            try: stream.close()
            except: pass

    def _waiter_thread(self, proc, status_dict, lock, callback=None):
        code = proc.wait()
        with lock:
            status_dict["running"] = False
            status_dict["exit_code"] = code
        if callback:
            callback()

    # ---------- Register Process ----------
    def start_register(self, body: dict):
        with self.register_lock:
            if self.register_proc is not None and self.register_proc.poll() is None:
                raise Exception("Registration process already running")

        threads = int(body.get("threads") or 1)
        data_dir = body.get("dataDir") or "./register/data"
        headless = bool(body.get("headless", True))
        continuous = bool(body.get("continuous", False))

        # Assuming register_cli.js is in the root or we need to adjust path
        base_dir = os.path.dirname(os.path.dirname(__file__))
        script_path = os.path.join(base_dir, "register_cli.js")
        
        args = ["node", script_path, "--threads", str(threads), "--data-dir", data_dir]
        if headless: args.append("--headless")
        if continuous: args.append("--continuous")

        env = os.environ.copy()
        env["MOEMAIL_BASE_URL"] = body.get("moemailBaseUrl") or "https://111.alanbulan.space"
        env["MOEMAIL_API_KEY"] = body.get("moemailApiKey") or "mk_4Pq6uyO5dDFF92fk6Hxs1qw0LWJls8wD"

        try:
            proc = subprocess.Popen(
                args, cwd=base_dir,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1, env=env
            )
        except FileNotFoundError:
            raise Exception("node executable not found")

        with self.register_lock:
            self.register_proc = proc
            self.register_status.update({"running": True, "exit_code": None, "started_at": int(time.time() * 1000)})

        if proc.stdout: threading.Thread(target=self._reader_thread, args=(proc.stdout, self.register_logs, self.register_lock), daemon=True).start()
        if proc.stderr: threading.Thread(target=self._reader_thread, args=(proc.stderr, self.register_logs, self.register_lock, "[ERR] "), daemon=True).start()
        threading.Thread(target=self._waiter_thread, args=(proc, self.register_status, self.register_lock, lambda: setattr(self, 'register_proc', None)), daemon=True).start()

    def stop_register(self):
        with self.register_lock:
            proc = self.register_proc
        if proc and proc.poll() is None:
            proc.terminate()

    def get_register_status(self):
        with self.register_lock:
            return {"process": dict(self.register_status), "logs": list(self.register_logs)}

    # ---------- Keepalive Process ----------
    def start_keepalive(self, body: dict, keepalive_url: str):
        with self.keepalive_lock:
            if self.keepalive_proc is not None and self.keepalive_proc.poll() is None:
                raise Exception("Keepalive process already running")

        threads = int(body.get("threads") or 1)
        data_dir = body.get("dataDir") or "./register/data"
        headless = bool(body.get("headless", True))
        continuous = bool(body.get("continuous", False))
        interval = int(body.get("intervalSeconds") or 0)

        base_dir = os.path.dirname(os.path.dirname(__file__))
        script_path = os.path.join(base_dir, "register", "login_keepalive.js")
        data_dir_abs = os.path.abspath(os.path.join(base_dir, data_dir)) if not os.path.isabs(data_dir) else data_dir

        # Get active profile id
        # 这里是个异步调用，但在同步上下文中，我们只能尽力而为或假设外部传入
        # 简化起见，我们在 process_manager 不直接做异步配置读取，而是依赖回调更新
        # 但为了记录 profile_id，我们可能需要外部传入或者在这里做同步等待（不推荐）
        # 这里的逻辑稍微调整：start_keepalive 不阻塞等待 profile，只是记录目录。
        # _apply_keepalive_result 会在回调中处理。

        with self.keepalive_lock:
            self.keepalive_data_dir = data_dir_abs
            # self.keepalive_profile_id 需要在外部设置或通过异步获取

        args = ["node", script_path, "--threads", str(threads), "--data-dir", data_dir]
        if headless: args.append("--headless")
        if continuous: args.append("--continuous")
        if interval > 0: args.extend(["--interval-seconds", str(interval)])

        env = os.environ.copy()
        env["MOEMAIL_BASE_URL"] = body.get("moemailBaseUrl") or "https://111.alanbulan.space"
        env["MOEMAIL_API_KEY"] = body.get("moemailApiKey") or "mk_4Pq6uyO5dDFF92fk6Hxs1qw0LWJls8wD"
        env["KEEPALIVE_UPDATE_URL"] = keepalive_url

        try:
            proc = subprocess.Popen(
                args, cwd=base_dir,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1, env=env
            )
        except FileNotFoundError:
            raise Exception("node executable not found")

        with self.keepalive_lock:
            self.keepalive_proc = proc
            self.keepalive_status.update({"running": True, "exit_code": None, "started_at": int(time.time() * 1000)})

        if proc.stdout: threading.Thread(target=self._reader_thread, args=(proc.stdout, self.keepalive_logs, self.keepalive_lock), daemon=True).start()
        if proc.stderr: threading.Thread(target=self._reader_thread, args=(proc.stderr, self.keepalive_logs, self.keepalive_lock, "[ERR] "), daemon=True).start()
        threading.Thread(target=self._waiter_thread, args=(proc, self.keepalive_status, self.keepalive_lock, self._on_keepalive_exit), daemon=True).start()

    def stop_keepalive(self):
        with self.keepalive_lock:
            proc = self.keepalive_proc
        if proc and proc.poll() is None:
            proc.terminate()

    def get_keepalive_status(self):
        with self.keepalive_lock:
            return {"process": dict(self.keepalive_status), "logs": list(self.keepalive_logs)}

    def set_keepalive_profile_id(self, pid: str):
        with self.keepalive_lock:
            self.keepalive_profile_id = pid

    def _on_keepalive_exit(self):
        with self.keepalive_lock:
            self.keepalive_proc = None
        self._apply_keepalive_result()

    def _find_latest_login_file(self, data_dir: str) -> Optional[str]:
        try:
            files = [f for f in os.listdir(data_dir) if f.endswith(".login.txt")]
        except FileNotFoundError:
            return None
        latest_path = None
        latest_mtime = 0.0
        for name in files:
            path = os.path.join(data_dir, name)
            try: mtime = os.path.getmtime(path)
            except OSError: continue
            if mtime > latest_mtime:
                latest_mtime = mtime
                latest_path = path
        return latest_path

    def _parse_login_txt(self, path: str) -> Dict[str, str]:
        result = {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    ln = line.strip()
                    if not ln or "=" not in ln: continue
                    key, value = ln.split("=", 1)
                    if key.strip() in ("SECURE_C_SES", "CSESIDX", "CONFIG_ID", "HOST_C_OSES"):
                        result[key.strip()] = value.strip()
        except Exception as e:
            logger.error(f"解析登录文件失败: {e}")
        return result

    def _apply_keepalive_result(self):
        if not self.loop:
            logger.warning("Loop not set, skipping keepalive apply")
            return
        
        with self.keepalive_lock:
            data_dir = self.keepalive_data_dir
            profile_id = self.keepalive_profile_id
        
        if not data_dir or not profile_id: return

        latest_file = self._find_latest_login_file(data_dir)
        if not latest_file: return

        values = self._parse_login_txt(latest_file)
        scs = values.get("SECURE_C_SES")
        csesidx = values.get("CSESIDX")
        cfg_id = values.get("CONFIG_ID")
        host = values.get("HOST_C_OSES")

        if scs and csesidx and cfg_id:
            asyncio.run_coroutine_threadsafe(
                self.config_store.update_profile(
                    profile_id, secure_c_ses=scs, csesidx=csesidx, config_id=cfg_id, host_c_oses=host
                ), self.loop
            )
