from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.api.web import error_response, json_response, request
from astrbot.core.db.po import ConversationV2, Preference
from astrbot.core.star.filter.command import CommandFilter
from astrbot.core.star.session_plugin_manager import SessionPluginManager
from astrbot.core.star.star import star_map
from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path
from sqlmodel import col, select

from .rules import Rule, RuleStore

PLUGIN_NAME = "astrbot_plugin_session_plugin_filter"
PATCH_ATTR = "filter_handlers_by_session"
MODE_LABELS = {"whitelist": "白名单", "blacklist": "黑名单"}


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

        for route, handler, methods in (
            ("state", self.api_state, ["GET"]),
            ("save", self.api_save, ["POST"]),
            ("import_native", self.api_import_native, ["POST"]),
        ):
            context.register_web_api(
                f"/{PLUGIN_NAME}/{route}", handler, methods, f"会话插件过滤 {route}"
            )

    # ---------- 过滤核心 ----------

    def _install_patch(self) -> None:
        current = getattr(SessionPluginManager, PATCH_ATTR)
        # 热重载时可能拿到上一个实例的包装，剥掉它避免套娃
        original = getattr(current, "__spf_original__", current)

        async def patched(event: AstrMessageEvent, handlers: list) -> list:
            handlers = await original(event, handlers)
            return self.apply_rules(event, handlers)

        patched.__spf_original__ = original
        self._original, self._patched = original, patched
        setattr(SessionPluginManager, PATCH_ATTR, staticmethod(patched))

    async def terminate(self):
        if getattr(SessionPluginManager, PATCH_ATTR) is self._patched:
            setattr(SessionPluginManager, PATCH_ATTR, staticmethod(self._original))

    def _is_exempt(self, plugin_name: str | None, reserved: bool) -> bool:
        return reserved or plugin_name == PLUGIN_NAME

    def apply_rules(self, event: AstrMessageEvent, handlers: list) -> list:
        self._remember_session(event)
        settings = self.store.settings
        if not settings["enabled"]:
            return handlers
        rule = self.store.match(event.unified_msg_origin)
        if rule is None or (settings["admin_bypass"] and event.is_admin()):
            return handlers

        kept, blocked_command = [], False
        for handler in handlers:
            plugin = star_map.get(handler.handler_module_path)
            if (
                plugin is None
                or self._is_exempt(plugin.name, plugin.reserved)
                or rule.allows(plugin.name)
            ):
                kept.append(handler)
            elif any(isinstance(f, CommandFilter) for f in handler.event_filters):
                blocked_command = True

        if rule.strict:
            # plugins_name 会继续约束后续的事件钩子和 LLM 函数工具
            event.plugins_name = self._narrow_plugins(rule, event.plugins_name)

        if blocked_command and settings["silent_blocked_command"]:
            if kept:
                event.should_call_llm(True)
            else:
                event.stop_event()
        return kept

    def _narrow_plugins(self, rule: Rule, current: list[str] | None) -> list[str]:
        names = [
            star.name
            for star in self.context.get_all_stars()
            if star.name
            and (self._is_exempt(star.name, star.reserved) or rule.allows(star.name))
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
        """会话插件过滤"""

    @filter.permission_type(filter.PermissionType.ADMIN)
    @pf.command("status")
    async def pf_status(self, event: AstrMessageEvent):
        """查看当前会话命中的规则"""
        umo = event.unified_msg_origin
        rule = self.store.match(umo)
        lines = [f"会话：{umo}"]
        if not self.store.settings["enabled"]:
            lines.append("插件过滤总开关已关闭")
        if rule is None:
            lines.append("没有命中任何规则，所有插件照常工作")
        else:
            lines.append(f"命中规则：{rule.name}（{MODE_LABELS[rule.mode]}）")
            allowed = [
                star.display_name or star.name
                for star in self.context.get_all_stars()
                if star.name
                and not self._is_exempt(star.name, star.reserved)
                and rule.allows(star.name)
            ]
            lines.append(f"可用插件（{len(allowed)}）：" + ("、".join(allowed) or "无"))
        yield event.plain_result("\n".join(lines))

    @filter.permission_type(filter.PermissionType.ADMIN)
    @pf.command("bind")
    async def pf_bind(self, event: AstrMessageEvent, rule_name: str):
        """把当前会话绑定到指定规则"""
        target = next(
            (r for r in self.store.rules if rule_name in (r.name, r.id)), None
        )
        if target is None:
            yield event.plain_result(f"找不到规则「{rule_name}」，先去面板里建一个")
            return
        umo = event.unified_msg_origin
        data = self.store.to_dict()
        for rule in data["rules"]:
            rule["sessions"] = [s for s in rule["sessions"] if s != umo]
            if rule["id"] == target.id:
                rule["sessions"].append(umo)
        self.store.update(data)
        self.store.save()
        yield event.plain_result(f"已把当前会话绑定到规则「{target.name}」")

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
            }
        )

    async def api_save(self):
        payload = await request.json(default={})
        if not isinstance(payload, dict) or not isinstance(payload.get("rules"), list):
            return error_response("配置格式不对")
        self.store.update(payload)
        self.store.save()
        logger.info(f"会话插件过滤规则已保存，共 {len(self.store.rules)} 条")
        return json_response(self.store.to_dict())

    async def api_import_native(self):
        """把原生「自定义规则」里的插件禁用配置转成黑名单规则（不落盘，由面板保存）"""
        groups: dict[tuple[str, ...], list[str]] = {}
        async with self.context.get_db().get_db() as session:
            result = await session.execute(
                select(Preference).where(
                    col(Preference.scope) == "umo",
                    col(Preference.key) == "session_plugin_config",
                )
            )
            for pref in result.scalars().all():
                conf = (pref.value or {}).get("val", {}).get(pref.scope_id, {})
                disabled = tuple(sorted(conf.get("disabled_plugins") or []))
                if disabled:
                    groups.setdefault(disabled, []).append(pref.scope_id)

        rules = [
            Rule.from_dict(
                {
                    "name": f"原生规则导入 #{i}",
                    "mode": "blacklist",
                    "strict": False,
                    "plugins": list(disabled),
                    "sessions": umos,
                }
            ).to_dict()
            for i, (disabled, umos) in enumerate(groups.items(), start=1)
        ]
        return json_response({"rules": rules})

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
