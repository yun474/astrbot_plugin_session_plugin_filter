"""会话规则：存储、校验与判定。

判定方式：
1. 插件：命中某会话的所有规则叠加生效，插件必须被每一条都放行才能用；
   被某条规则标为「专属」的插件，只能在这条规则覆盖的会话里使用。
2. 会话设置：每一项取最具体的规则，精确会话优先于通配符，同级时列表靠前的优先。
"""

import json
import re
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

MODES = ("whitelist", "blacklist")
EXCLUDE_PREFIX = "!"
NO_PERSONA = "[%None]"

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

# 会话设置项，缺省表示不修改、沿用原生配置
BOOL_OVERRIDES = ("session_enabled", "llm_enabled", "tts_enabled")
STR_OVERRIDES = ("persona", "chat_provider", "stt_provider", "tts_provider")
KB_TOP_K_RANGE = (1, 50)


def compile_pattern(pattern: str) -> re.Pattern:
    """会话通配符：* 匹配任意串，? 匹配单个字符，其余按字面量处理"""
    return re.compile(re.escape(pattern).replace(r"\*", ".*").replace(r"\?", "."))


def _str_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    items = (str(v).strip() for v in value)
    return list(dict.fromkeys(v for v in items if v))


def normalize_overrides(data) -> dict:
    if not isinstance(data, dict):
        return {}
    result = {}
    for key in BOOL_OVERRIDES:
        if isinstance(data.get(key), bool):
            result[key] = data[key]
    for key in STR_OVERRIDES:
        if isinstance(data.get(key), str) and data[key].strip():
            result[key] = data[key].strip()
    # 知识库：ids 为空表示不使用知识库，top_k 为空表示沿用默认
    kb = data.get("kb")
    if isinstance(kb, dict) and isinstance(kb.get("ids"), list):
        top_k = kb.get("top_k")
        if isinstance(top_k, int) and not isinstance(top_k, bool):
            top_k = min(max(top_k, KB_TOP_K_RANGE[0]), KB_TOP_K_RANGE[1])
        else:
            top_k = None
        result["kb"] = {"ids": _str_list(kb["ids"]), "top_k": top_k}
    return result


class SessionMatcher:
    def __init__(self, sessions: list[str]) -> None:
        self.exact = {s for s in sessions if "*" not in s and "?" not in s}
        self.patterns = [compile_pattern(s) for s in sessions if s not in self.exact]

    def level(self, umo: str) -> int:
        """2 表示精确命中，1 表示通配符命中，0 表示未命中"""
        if umo in self.exact:
            return 2
        return 1 if any(p.fullmatch(umo) for p in self.patterns) else 0


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
    # 会话设置：会话开关、LLM/TTS 开关、人格、模型、知识库
    overrides: dict = field(default_factory=dict)

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
            overrides=normalize_overrides(data.get("overrides")),
        )

    def to_dict(self) -> dict:
        return asdict(self)

    def match_level(self, umo: str) -> int:
        return 0 if self._exclude.level(umo) else self._include.level(umo)

    def covers(self, umo: str) -> bool:
        return self.match_level(umo) > 0

    def allows(self, plugin_name: str) -> bool:
        return (plugin_name in self._plugin_set) == (self.mode == "whitelist")

    @property
    def restricts_plugins(self) -> bool:
        return self.mode == "whitelist" or bool(self.plugins)


@dataclass
class Verdict:
    """某个会话的插件判定结果"""

    rules: list[Rule]
    exclusive: dict[str, list[Rule]]

    def blocker(self, plugin_name: str) -> Rule | None:
        """返回拦下该插件的规则，放行时返回 None"""
        for rule in self.rules:
            if not rule.allows(plugin_name):
                return rule
        owners = self.exclusive.get(plugin_name)
        if owners and not any(o is r for o in owners for r in self.rules):
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
        self._overrides_cache: dict[str, dict[str, tuple]] = {}

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
        self._overrides_cache = {}

    def resolve(self, umo: str) -> Verdict | None:
        """计算会话的插件判定；没有任何规则影响该会话时返回 None"""
        rules = [rule for rule in self.rules if rule.enabled and rule.covers(umo)]
        if not rules and not self._exclusive:
            return None
        return Verdict(rules, self._exclusive)

    def overrides(self, umo: str) -> dict[str, tuple]:
        """会话最终生效的设置项：{设置项: (值, 来源规则)}"""
        cached = self._overrides_cache.get(umo)
        if cached is not None:
            return cached
        ranked = sorted(
            (
                (-rule.match_level(umo), index, rule)
                for index, rule in enumerate(self.rules)
                if rule.enabled and rule.overrides
            ),
            key=lambda item: item[:2],
        )
        result: dict[str, tuple] = {}
        for level, _, rule in ranked:
            if not level:
                break
            for key, value in rule.overrides.items():
                result.setdefault(key, (value, rule))
        self._overrides_cache[umo] = result
        return result
