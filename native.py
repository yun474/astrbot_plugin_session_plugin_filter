"""对接 AstrBot 原生的会话规则存储。

原生的会话开关、LLM/TTS 开关、人格、模型、知识库都存在 SharedPreferences 的
umo 作用域里，运行时统一通过 sp.get_async / sp.get 读取。这里包装这两个入口，
把本插件规则里的会话设置叠加到原生值上，不改动原生存储本身。
"""

import json

from astrbot.core import sp
from astrbot.core.db.po import Preference
from sqlmodel import col, select

from .rules import BOOL_OVERRIDES, RuleStore

SERVICE_KEY = "session_service_config"
PLUGIN_KEY = "session_plugin_config"
KB_KEY = "kb_config"
PROVIDER_KEYS = {
    "provider_perf_chat_completion": "chat_provider",
    "provider_perf_speech_to_text": "stt_provider",
    "provider_perf_text_to_speech": "tts_provider",
}
OVERLAY_KEYS = {SERVICE_KEY, KB_KEY, *PROVIDER_KEYS}
NATIVE_RULE_KEYS = [SERVICE_KEY, PLUGIN_KEY, KB_KEY, *PROVIDER_KEYS]
DEFAULT_KB_TOP_K = 5


def overlay(key: str, value, overrides: dict):
    """把规则设置叠加到原生值上，没有相关设置时原样返回"""
    if key == SERVICE_KEY:
        fields = {
            name: overrides[name][0] for name in BOOL_OVERRIDES if name in overrides
        }
        if "persona" in overrides:
            fields["persona_id"] = overrides["persona"][0]
        if not fields:
            return value
        return {**(value if isinstance(value, dict) else {}), **fields}
    if key in PROVIDER_KEYS:
        hit = overrides.get(PROVIDER_KEYS[key])
        return hit[0] if hit else value
    if key == KB_KEY and "kb" in overrides:
        kb = overrides["kb"][0]
        base = value if isinstance(value, dict) else {}
        return {
            **base,
            "kb_ids": list(kb["ids"]),
            "top_k": kb["top_k"] or base.get("top_k", DEFAULT_KB_TOP_K),
        }
    return value


class PreferenceOverlay:
    """包装 sp 的读取入口，热重载时会剥掉上一个实例的包装"""

    def __init__(self, store: RuleStore) -> None:
        self.store = store
        self._originals: dict = {}
        self._wrappers: dict = {}

    def _active(self, scope, key) -> bool:
        return scope == "umo" and key in OVERLAY_KEYS and self.store.settings["enabled"]

    def install(self) -> None:
        original_async = getattr(sp.get_async, "__spf_original__", sp.get_async)
        original_sync = getattr(sp.get, "__spf_original__", sp.get)

        async def get_async(scope, scope_id, key, default=None):
            value = await original_async(scope, scope_id, key, default)
            if not self._active(scope, key):
                return value
            return overlay(key, value, self.store.overrides(scope_id))

        def get(key, default=None, scope=None, scope_id=""):
            value = original_sync(key, default, scope, scope_id)
            if not self._active(scope, key):
                return value
            return overlay(key, value, self.store.overrides(scope_id))

        get_async.__spf_original__ = original_async
        get.__spf_original__ = original_sync
        self._originals = {"get_async": original_async, "get": original_sync}
        self._wrappers = {"get_async": get_async, "get": get}
        for name, wrapper in self._wrappers.items():
            setattr(sp, name, wrapper)

    def uninstall(self) -> None:
        for name, wrapper in self._wrappers.items():
            if sp.__dict__.get(name) is wrapper:
                setattr(sp, name, self._originals[name])


async def _native_rows(db) -> list[Preference]:
    async with db.get_db() as session:
        result = await session.execute(
            select(Preference).where(
                col(Preference.scope) == "umo",
                col(Preference.key).in_(NATIVE_RULE_KEYS),
            )
        )
        return list(result.scalars().all())


def _rule_from_native(umo: str, prefs: dict) -> dict:
    """把一个会话的原生规则转成本插件的规则内容"""
    plugin_conf = (prefs.get(PLUGIN_KEY) or {}).get(umo) or {}
    service = prefs.get(SERVICE_KEY) or {}
    overrides = {name: False for name in BOOL_OVERRIDES if service.get(name) is False}
    if service.get("persona_id"):
        overrides["persona"] = service["persona_id"]
    for key, name in PROVIDER_KEYS.items():
        if isinstance(prefs.get(key), str) and prefs[key]:
            overrides[name] = prefs[key]
    kb = prefs.get(KB_KEY)
    if isinstance(kb, dict) and isinstance(kb.get("kb_ids"), list):
        overrides["kb"] = {"ids": kb["kb_ids"], "top_k": kb.get("top_k")}
    return {
        "mode": "blacklist",
        "plugins": sorted(plugin_conf.get("disabled_plugins") or []),
        "overrides": overrides,
    }


async def import_native_rules(db) -> list[dict]:
    """读取原生自定义规则，内容相同的会话合并成一条规则"""
    by_umo: dict[str, dict] = {}
    for pref in await _native_rows(db):
        by_umo.setdefault(pref.scope_id, {})[pref.key] = (pref.value or {}).get("val")

    groups: dict[str, dict] = {}
    for umo, prefs in sorted(by_umo.items()):
        content = _rule_from_native(umo, prefs)
        if not content["plugins"] and not content["overrides"]:
            continue
        group_key = json.dumps(content, sort_keys=True, ensure_ascii=False)
        groups.setdefault(group_key, {**content, "sessions": []})["sessions"].append(
            umo
        )
    return [
        {"name": f"原生规则导入 #{i}", **rule}
        for i, rule in enumerate(groups.values(), start=1)
    ]


async def clear_native_rules(db) -> int:
    """删除原生自定义规则（保留会话备注名），返回涉及的会话数"""
    umos = set()
    for pref in await _native_rows(db):
        val = (pref.value or {}).get("val")
        if pref.key == SERVICE_KEY and isinstance(val, dict) and val.get("custom_name"):
            if set(val) == {"custom_name"}:
                continue
            await sp.session_put(
                pref.scope_id, SERVICE_KEY, {"custom_name": val["custom_name"]}
            )
        else:
            await sp.session_remove(pref.scope_id, pref.key)
        umos.add(pref.scope_id)
    return len(umos)
