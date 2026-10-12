"""会话插件规则：存储、校验与判定。

判定方式：
1. 命中某会话的所有规则叠加生效，插件必须被每一条都放行才能用；
2. 被某条规则标为「专属」的插件，只能在这条规则覆盖的会话里使用。
"""

import json
import re
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

MODES = ("whitelist", "blacklist")
EXCLUDE_PREFIX = "!"

DEFAULT_SETTINGS = {
    # 总开关，关闭后所有规则失效
    "enabled": True,
    # 同时屏蔽被拦插件的事件钩子（on_llm_request 等）和 LLM 函数工具
    "strict": True,
    # 命中被屏蔽插件的指令时直接吞掉消息，不再落到 LLM 闲聊
    "silent_blocked_command": True,
    # 管理员不受规则限制
    "admin_bypass": False,
}


def compile_pattern(pattern: str) -> re.Pattern:
    """会话通配符：* 匹配任意串，? 匹配单个字符，其余按字面量处理"""
    return re.compile(re.escape(pattern).replace(r"\*", ".*").replace(r"\?", "."))


def _str_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    items = (str(v).strip() for v in value)
    return list(dict.fromkeys(v for v in items if v))


class SessionMatcher:
    def __init__(self, sessions: list[str]) -> None:
        self.exact = {s for s in sessions if "*" not in s and "?" not in s}
        self.patterns = [compile_pattern(s) for s in sessions if s not in self.exact]

    def __call__(self, umo: str) -> bool:
        return umo in self.exact or any(p.fullmatch(umo) for p in self.patterns)


@dataclass
class Rule:
    id: str
    name: str
    mode: str = "whitelist"
    enabled: bool = True
    plugins: list[str] = field(default_factory=list)
    # 专属插件：只能在本规则覆盖的会话里使用
    exclusive: list[str] = field(default_factory=list)
    # 会话 ID 或通配符，以 ! 开头表示排除
    sessions: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        # 白名单里的专属插件必然放行；黑名单里屏蔽和专属互斥，以专属为准
        if self.mode == "whitelist":
            self.plugins = list(dict.fromkeys(self.plugins + self.exclusive))
        else:
            self.plugins = [p for p in self.plugins if p not in self.exclusive]
        self._plugin_set = set(self.plugins)
        self._include = SessionMatcher(
            [s for s in self.sessions if not s.startswith(EXCLUDE_PREFIX)]
        )
        self._exclude = SessionMatcher(
            [s[1:] for s in self.sessions if s.startswith(EXCLUDE_PREFIX)]
        )

    @classmethod
    def from_dict(cls, data: dict) -> "Rule":
        mode = data.get("mode")
        return cls(
            id=str(data.get("id") or uuid.uuid4().hex[:8]),
            name=str(data.get("name") or "").strip() or "未命名规则",
            mode=mode if mode in MODES else "whitelist",
            enabled=bool(data.get("enabled", True)),
            plugins=_str_list(data.get("plugins")),
            exclusive=_str_list(data.get("exclusive")),
            sessions=_str_list(data.get("sessions")),
        )

    def to_dict(self) -> dict:
        return asdict(self)

    def covers(self, umo: str) -> bool:
        return self._include(umo) and not self._exclude(umo)

    def allows(self, plugin_name: str) -> bool:
        return (plugin_name in self._plugin_set) == (self.mode == "whitelist")


@dataclass
class Verdict:
    """某个会话的判定结果"""

    rules: list[Rule]
    exclusive: dict[str, list[Rule]]

    def blocker(self, plugin_name: str) -> Rule | None:
        """返回拦下该插件的规则，放行时返回 None"""
        for rule in self.rules:
            if not rule.allows(plugin_name):
                return rule
        owners = self.exclusive.get(plugin_name)
        if owners and not any(rule in self.rules for rule in owners):
            return owners[0]
        return None

    def allows(self, plugin_name: str) -> bool:
        return self.blocker(plugin_name) is None


class RuleStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.settings = dict(DEFAULT_SETTINGS)
        self.rules: list[Rule] = []
        self._exclusive: dict[str, list[Rule]] = {}

    def load(self) -> None:
        if self.path.exists():
            self.update(json.loads(self.path.read_text(encoding="utf-8")))

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        tmp.replace(self.path)

    def to_dict(self) -> dict:
        return {
            "settings": dict(self.settings),
            "rules": [rule.to_dict() for rule in self.rules],
        }

    def update(self, data: dict) -> None:
        settings = data.get("settings")
        if not isinstance(settings, dict):
            settings = {}
        self.settings = {
            key: bool(settings.get(key, default))
            for key, default in DEFAULT_SETTINGS.items()
        }

        rules = [
            Rule.from_dict(r) for r in data.get("rules") or [] if isinstance(r, dict)
        ]
        seen_ids = set()
        for rule in rules:
            if rule.id in seen_ids:
                rule.id = uuid.uuid4().hex[:8]
            seen_ids.add(rule.id)
        self.rules = rules

        self._exclusive = {}
        for rule in rules:
            if rule.enabled:
                for name in rule.exclusive:
                    self._exclusive.setdefault(name, []).append(rule)

    def resolve(self, umo: str) -> Verdict | None:
        """计算会话的判定结果；没有任何规则影响该会话时返回 None"""
        rules = [rule for rule in self.rules if rule.enabled and rule.covers(umo)]
        if not rules and not self._exclusive:
            return None
        return Verdict(rules, self._exclusive)
