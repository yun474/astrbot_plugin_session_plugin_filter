"""会话插件规则：存储、校验与会话匹配。"""

import json
import re
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

MODES = ("whitelist", "blacklist")

DEFAULT_SETTINGS = {
    # 总开关，关闭后所有规则失效
    "enabled": True,
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


@dataclass
class Rule:
    id: str
    name: str
    mode: str = "whitelist"
    enabled: bool = True
    # 同时过滤该插件的事件钩子（on_llm_request 等）和 LLM 函数工具
    strict: bool = True
    plugins: list[str] = field(default_factory=list)
    sessions: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._plugin_set = set(self.plugins)

    @classmethod
    def from_dict(cls, data: dict) -> "Rule":
        mode = data.get("mode")
        return cls(
            id=str(data.get("id") or uuid.uuid4().hex[:8]),
            name=str(data.get("name") or "").strip() or "未命名规则",
            mode=mode if mode in MODES else "whitelist",
            enabled=bool(data.get("enabled", True)),
            strict=bool(data.get("strict", True)),
            plugins=_str_list(data.get("plugins")),
            sessions=_str_list(data.get("sessions")),
        )

    def to_dict(self) -> dict:
        return asdict(self)

    def allows(self, plugin_name: str) -> bool:
        return (plugin_name in self._plugin_set) == (self.mode == "whitelist")


class RuleStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.settings = dict(DEFAULT_SETTINGS)
        self.rules: list[Rule] = []
        self._exact: dict[str, Rule] = {}
        self._patterns: list[tuple[re.Pattern, Rule]] = []

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
        self._build_index()

    def _build_index(self) -> None:
        # 精确会话优先于通配符；同类之间按规则顺序，先到先得
        self._exact, self._patterns = {}, []
        for rule in self.rules:
            if not rule.enabled:
                continue
            for session in rule.sessions:
                if "*" in session or "?" in session:
                    self._patterns.append((compile_pattern(session), rule))
                else:
                    self._exact.setdefault(session, rule)

    def match(self, umo: str) -> Rule | None:
        rule = self._exact.get(umo)
        if rule:
            return rule
        for pattern, rule in self._patterns:
            if pattern.fullmatch(umo):
                return rule
        return None
