from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.api.web import error_response, json_response, request
from astrbot.core.db.po import ConversationV2
from astrbot.core.star.filter.command import CommandFilter
from astrbot.core.star.session_plugin_manager import SessionPluginManager
from astrbot.core.star.star import star_map
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path
from sqlmodel import select

from .native import PreferenceOverlay, clear_native_rules, import_native_rules
from .rules import NO_PERSONA, Rule, RuleStore, Verdict

PLUGIN_NAME = "astrbot_plugin_session_plugin_filter"
PATCH_ATTR = "filter_handlers_by_session"
# 不经过消息流水线的事件（如官方 SDK 的进群事件）只能靠插件主动查询这个接口
ENABLED_ATTR = "is_plugin_enabled_for_session"
MODE_LABELS = {"whitelist": "白名单", "blacklist": "黑名单"}
SETTING_LABELS = {
    "session_enabled": "会话",
    "llm_enabled": "LLM",
    "tts_enabled": "TTS",
    "persona": "人格",
    "chat_provider": "对话模型",
    "stt_provider": "语音识别模型",
    "tts_provider": "语音合成模型",
    "kb": "知识库",
}


def describe_setting(key: str, value) -> str:
    if isinstance(value, bool):
        return "开启" if value else "关闭"
    if key == "persona" and value == NO_PERSONA:
        return "不使用人格"
    if key == "kb":
        return f"{len(value['ids'])} 个知识库" if value["ids"] else "不使用知识库"
    return str(value)


class SessionPluginFilter(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.store = RuleStore(
            Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME / "rules.json"
        )
        self.store.load()
        # 最近出现过的会话 -> 群名/昵称，给面板的会话选择器用
        self.recent_sessions: dict[str, str] = {}
        self._install_patch()
        self.overlay = PreferenceOverlay(self.store)
        self.overlay.install()

        for route, handler, methods in (
            ("state", self.api_state, ["GET"]),
            ("save", self.api_save, ["POST"]),
            ("import_native", self.api_import_native, ["POST"]),
            ("clear_native", self.api_clear_native, ["POST"]),
        ):
            context.register_web_api(
                f"/{PLUGIN_NAME}/{route}", handler, methods, f"会话规则 {route}"
            )

    # ---------- 插件过滤 ----------

    def _install_patch(self) -> None:
        # 热重载时可能拿到上一个实例的包装，剥掉它避免套娃
        originals = {}
        for attr in (PATCH_ATTR, ENABLED_ATTR):
            current = getattr(SessionPluginManager, attr)
            originals[attr] = getattr(current, "__spf_original__", current)
        filter_original = originals[PATCH_ATTR]
        enabled_original = originals[ENABLED_ATTR]

        async def patched_filter(event: AstrMessageEvent, handlers: list) -> list:
            handlers = await filter_original(event, handlers)
            return self.apply_rules(event, handlers)

        async def patched_enabled(session_id: str, plugin_name: str) -> bool:
            if not await enabled_original(session_id, plugin_name):
                return False
            return self.plugin_allowed(session_id, plugin_name)

        self._originals = originals
        self._patches = {PATCH_ATTR: patched_filter, ENABLED_ATTR: patched_enabled}
        for attr, patched in self._patches.items():
            patched.__spf_original__ = originals[attr]
            setattr(SessionPluginManager, attr, staticmethod(patched))

    async def terminate(self):
        for attr, patched in self._patches.items():
            if getattr(SessionPluginManager, attr) is patched:
                setattr(SessionPluginManager, attr, staticmethod(self._originals[attr]))
        self.overlay.uninstall()

    def _is_exempt(self, plugin_name: str | None, reserved: bool) -> bool:
        return reserved or plugin_name == PLUGIN_NAME

    def plugin_allowed(self, umo: str, plugin_name: str) -> bool:
        """没有消息事件时按规则判断插件能否在会话中使用，管理员放行对此不适用"""
        if not self.store.settings["enabled"]:
            return True
        star = next(
            (s for s in self.context.get_all_stars() if s.name == plugin_name), None
        )
        if self._is_exempt(plugin_name, bool(star and star.reserved)):
            return True
        verdict = self.store.resolve(umo)
        return verdict is None or verdict.allows(plugin_name)

    def apply_rules(self, event: AstrMessageEvent, handlers: list) -> list:
        self._remember_session(event)
        settings = self.store.settings
        if not settings["enabled"]:
            return handlers
        verdict = self.store.resolve(event.unified_msg_origin)
        if verdict is None or (settings["admin_bypass"] and event.is_admin()):
            return handlers

        kept, blocked_command = [], False
        for handler in handlers:
            plugin = star_map.get(handler.handler_module_path)
            if (
                plugin is None
                or self._is_exempt(plugin.name, plugin.reserved)
                or verdict.allows(plugin.name)
            ):
                kept.append(handler)
            elif any(isinstance(f, CommandFilter) for f in handler.event_filters):
                blocked_command = True

        if settings["strict"]:
            # plugins_name 会继续约束后续的事件钩子和 LLM 函数工具
            event.plugins_name = self._narrow_plugins(verdict, event.plugins_name)

        if blocked_command and settings["silent_blocked_command"]:
            if kept:
                event.should_call_llm(True)
            else:
                event.stop_event()
        return kept

    def _narrow_plugins(self, verdict: Verdict, current: list[str] | None) -> list[str]:
        names = [
            star.name
            for star in self.context.get_all_stars()
            if star.name
            and (self._is_exempt(star.name, star.reserved) or verdict.allows(star.name))
        ]
        if current is not None:
            names = [name for name in names if name in current]
        return names

    def _remember_session(self, event: AstrMessageEvent) -> None:
        group = getattr(event.message_obj, "group", None)
        name = getattr(group, "group_name", "") or (
            event.get_sender_name() if event.is_private_chat() else ""
        )
        umo = event.unified_msg_origin
        self.recent_sessions[umo] = name or self.recent_sessions.get(umo, "")

    # ---------- 聊天指令 ----------

    @filter.command_group("pf")
    def pf(self):
        """会话规则"""

    @filter.permission_type(filter.PermissionType.ADMIN)
    @pf.command("status")
    async def pf_status(self, event: AstrMessageEvent):
        """查看当前会话命中的规则、可用插件和会话设置"""
        umo = event.unified_msg_origin
        lines = [f"会话：{umo}"]
        if not self.store.settings["enabled"]:
            lines.append("规则总开关已关闭，以下内容暂不生效")
        rules = [r for r in self.store.rules if r.enabled and r.covers(umo)]
        names = "、".join(
            r.name + (f"（{MODE_LABELS[r.mode]}）" if r.restricts_plugins else "")
            for r in rules
        )
        lines.append(f"命中规则：{names or '无'}")

        verdict = self.store.resolve(umo)
        stars = [
            star
            for star in self.context.get_all_stars()
            if star.name and not self._is_exempt(star.name, star.reserved)
        ]
        allowed = [
            s.display_name or s.name
            for s in stars
            if verdict is None or verdict.allows(s.name)
        ]
        lines.append(
            f"可用插件（{len(allowed)}/{len(stars)}）：" + ("、".join(allowed) or "无")
        )
        for key, (value, rule) in self.store.overrides(umo).items():
            lines.append(
                f"{SETTING_LABELS[key]}：{describe_setting(key, value)}（来自「{rule.name}」）"
            )
        yield event.plain_result("\n".join(lines))

    @filter.permission_type(filter.PermissionType.ADMIN)
    @pf.command("bind")
    async def pf_bind(self, event: AstrMessageEvent, rule_name: str):
        """把当前会话加入指定规则"""
        target = next(
            (r for r in self.store.rules if rule_name in (r.name, r.id)), None
        )
        if target is None:
            yield event.plain_result(f"找不到规则「{rule_name}」，先去面板里建一个")
            return
        umo = event.unified_msg_origin
        data = self.store.to_dict()
        for rule in data["rules"]:
            if rule["id"] == target.id and umo not in rule["sessions"]:
                rule["sessions"].append(umo)
        self.store.update(data)
        self.store.save()
        yield event.plain_result(f"已把当前会话加入规则「{target.name}」")

    @filter.permission_type(filter.PermissionType.ADMIN)
    @pf.command("unbind")
    async def pf_unbind(self, event: AstrMessageEvent):
        """把当前会话从所有规则中移除（通配符规则不受影响）"""
        umo = event.unified_msg_origin
        data = self.store.to_dict()
        for rule in data["rules"]:
            rule["sessions"] = [s for s in rule["sessions"] if s != umo]
        self.store.update(data)
        self.store.save()
        yield event.plain_result("已解绑当前会话")

    # ---------- 面板 API ----------

    async def api_state(self):
        plugins = [
            {
                "name": star.name,
                "display_name": star.display_name or star.name,
                "desc": star.desc or "",
                "activated": star.activated,
            }
            for star in self.context.get_all_stars()
            if star.name and not self._is_exempt(star.name, star.reserved)
        ]
        return json_response(
            {
                **self.store.to_dict(),
                "plugins": sorted(plugins, key=lambda p: p["display_name"].lower()),
                "sessions": await self._known_sessions(),
                "options": await self._setting_options(),
            }
        )

    async def api_save(self):
        payload = await request.json(default={})
        if not isinstance(payload, dict) or not isinstance(payload.get("rules"), list):
            return error_response("配置格式不对")
        self.store.update(payload)
        self.store.save()
        logger.info(f"会话规则已保存，共 {len(self.store.rules)} 条")
        return json_response(self.store.to_dict())

    async def api_import_native(self):
        """把原生自定义规则转成本插件的规则（不落盘，由面板保存）"""
        rules = await import_native_rules(self.context.get_db())
        return json_response({"rules": [Rule.from_dict(r).to_dict() for r in rules]})

    async def api_clear_native(self):
        count = await clear_native_rules(self.context.get_db())
        logger.info(f"已清除 {count} 个会话的原生自定义规则")
        return json_response({"count": count})

    async def _setting_options(self) -> dict:
        def providers(insts) -> list[dict]:
            return [{"id": p.meta().id, "model": p.meta().model} for p in insts]

        kbs = await self.context.kb_manager.list_kbs()
        return {
            "personas": [p["name"] for p in self.context.persona_manager.personas_v3],
            "chat_providers": providers(self.context.get_all_providers()),
            "stt_providers": providers(self.context.get_all_stt_providers()),
            "tts_providers": providers(self.context.get_all_tts_providers()),
            "kbs": [
                {"id": kb.kb_id, "name": kb.kb_name, "emoji": kb.emoji or ""}
                for kb in kbs
            ],
        }

    async def _known_sessions(self) -> list[dict]:
        db = self.context.get_db()
        names = dict(self.recent_sessions)
        async with db.get_db() as session:
            result = await session.execute(select(ConversationV2.user_id).distinct())
            for (umo,) in result.fetchall():
                if umo:
                    names.setdefault(str(umo), "")
        for alias in await db.get_umo_aliases():
            names[alias.umo] = (
                alias.user_alias or alias.auto_name or names.get(alias.umo, "")
            )
        return [{"umo": umo, "name": name} for umo, name in sorted(names.items())]
