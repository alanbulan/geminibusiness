import json
import os
import uuid
import asyncio
from typing import Dict, List, Optional, Any
from pydantic import BaseModel

class ConfigProfile(BaseModel):
    id: str
    name: str
    secure_c_ses: str
    host_c_oses: Optional[str] = None
    csesidx: str
    config_id: str
    proxy: Optional[str] = None
    is_active: bool = False
    status: str = "Unknown"  # Valid, Invalid, Unknown
    last_checked: int = 0    # Timestamp

class ConfigStore:
    def __init__(self, path: str, env_defaults: Optional[Dict[str, Optional[str]]] = None) -> None:
        self.path = path
        self._profiles: Dict[str, ConfigProfile] = {}
        self._active_id: Optional[str] = None
        self._env_defaults = env_defaults or {}
        self._lock = asyncio.Lock()
        self._load()

    def _load(self) -> None:
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                profiles = raw.get("profiles", [])
                self._active_id = raw.get("active_id")
                for item in profiles:
                    p = ConfigProfile(**item)
                    self._profiles[p.id] = p
                if self._active_id not in self._profiles:
                    self._active_id = None
            except Exception:
                self._profiles = {}
                self._active_id = None

        if not self._profiles:
            scs = self._env_defaults.get("secure_c_ses")
            csesidx = self._env_defaults.get("csesidx")
            cfg_id = self._env_defaults.get("config_id")
            if scs and csesidx and cfg_id:
                p = ConfigProfile(
                    id="default",
                    name="默认配置",
                    secure_c_ses=scs,
                    host_c_oses=self._env_defaults.get("host_c_oses"),
                    csesidx=csesidx,
                    config_id=cfg_id,
                    proxy=self._env_defaults.get("proxy"),
                    is_active=True,
                )
                self._profiles[p.id] = p
                self._active_id = p.id
                self._save()

    def _save(self) -> None:
        data = {
            "active_id": self._active_id,
            "profiles": [p.dict() for p in self._profiles.values()],
        }
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    async def list_profiles(self) -> List[ConfigProfile]:
        async with self._lock:
            return list(self._profiles.values())

    async def get_active_profile(self) -> ConfigProfile:
        async with self._lock:
            if self._active_id and self._active_id in self._profiles:
                return self._profiles[self._active_id]
            raise RuntimeError("No active config profile")

    async def set_active(self, profile_id: str) -> ConfigProfile:
        async with self._lock:
            if profile_id not in self._profiles:
                raise KeyError("Profile not found")
            for pid, p in self._profiles.items():
                p.is_active = pid == profile_id
            self._active_id = profile_id
            self._save()
            return self._profiles[profile_id]

    async def create_profile(
        self,
        name: str,
        secure_c_ses: str,
        csesidx: str,
        config_id: str,
        host_c_oses: Optional[str],
        proxy: Optional[str],
    ) -> ConfigProfile:
        async with self._lock:
            new_id = uuid.uuid4().hex[:8]
            while new_id in self._profiles:
                new_id = uuid.uuid4().hex[:8]
            p = ConfigProfile(
                id=new_id,
                name=name,
                secure_c_ses=secure_c_ses,
                host_c_oses=host_c_oses,
                csesidx=csesidx,
                config_id=config_id,
                proxy=proxy,
                is_active=not self._profiles,
            )
            self._profiles[p.id] = p
            if p.is_active:
                self._active_id = p.id
            self._save()
            return p

    async def update_profile(self, profile_id: str, **kwargs: Any) -> ConfigProfile:
        async with self._lock:
            if profile_id not in self._profiles:
                raise KeyError("Profile not found")
            p = self._profiles[profile_id]
            for k, v in kwargs.items():
                if v is not None and hasattr(p, k):
                    setattr(p, k, v)
            self._save()
            return p

    async def delete_profile(self, profile_id: str) -> None:
        async with self._lock:
            if profile_id not in self._profiles:
                raise KeyError("Profile not found")
            was_active = self._active_id == profile_id
            self._profiles.pop(profile_id)
            if was_active:
                self._active_id = None
                if self._profiles:
                    first_id = next(iter(self._profiles.keys()))
                    self._profiles[first_id].is_active = True
                    self._active_id = first_id
            self._save()

    def has_active(self) -> bool:
        return self._active_id is not None and self._active_id in self._profiles
