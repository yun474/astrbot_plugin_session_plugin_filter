const bridge = window.AstrBotPluginView || window.AstrBotPluginPage;

const MODE_TEXT = { whitelist: "白名单", blacklist: "黑名单" };
const MODE_OPTION = { whitelist: "只允许勾选的插件", blacklist: "禁用勾选的插件" };
const QUICK_PATTERNS = [
  ["所有群聊", "*:GroupMessage:*"],
  ["所有私聊", "*:FriendMessage:*"],
];
const NO_PERSONA = "[%None]";
const SWITCHES = [
  ["session_enabled", "会话", "关闭后 Bot 在这些会话里完全不响应"],
  ["llm_enabled", "LLM 回复", "关闭后不再调用大模型聊天，插件指令照常可用"],
  ["tts_enabled", "语音合成", "关闭后回复不再转成语音"],
];
const PROVIDERS = [
  ["chat_provider", "对话模型", "chat_providers"],
  ["stt_provider", "语音识别模型", "stt_providers"],
  ["tts_provider", "语音合成模型", "tts_providers"],
];
const SETTING_LABELS = {
  session_enabled: "会话",
  llm_enabled: "LLM 回复",
  tts_enabled: "语音合成",
  persona: "人格",
  chat_provider: "对话模型",
  stt_provider: "语音识别模型",
  tts_provider: "语音合成模型",
  kb: "知识库",
};

let plugins = [];
let options = { personas: [], chat_providers: [], stt_providers: [], tts_providers: [], kbs: [] };
let sessionNames = new Map();
let draft = { settings: {}, rules: [] };
let savedJson = "";
let selectedId = null;
let pluginQuery = "";
let editorTab = "plugins";

const $ = (id) => document.getElementById(id);
const DOM_PROPS = new Set(["checked", "disabled", "hidden", "value", "selected"]);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (DOM_PROPS.has(key)) el[key] = value;
    else if (value != null) el.setAttribute(key, value);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 5000 : 2500);
}

// 需要二次点击确认的按钮（iframe 沙箱里没有 confirm()）
function confirmButton(label, armedLabel, onConfirm, cls = "btn ghost small danger") {
  const btn = h("button", { class: cls }, label);
  btn.addEventListener("click", () => {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.textContent = armedLabel;
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = label;
      }, 3000);
      return;
    }
    onConfirm();
  });
  return btn;
}

const newId = () => Math.random().toString(16).slice(2, 10);
const pluginName = (name) => plugins.find((p) => p.name === name)?.display_name || name;
const kbName = (id) => options.kbs.find((k) => k.id === id)?.name || id;
const selectedRule = () => draft.rules.find((r) => r.id === selectedId);

function describeSetting(key, value) {
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (key === "persona") return value === NO_PERSONA ? "不使用人格" : `「${value}」`;
  if (key === "kb") {
    if (!value.ids.length) return "不使用";
    return value.ids.map(kbName).join("、") + (value.top_k ? `（取 ${value.top_k} 条）` : "");
  }
  return value;
}

// ---------- 规则判定（与后端 rules.py 保持一致） ----------

const isExclude = (s) => s.startsWith("!");
const isPattern = (s) => /[*?]/.test(s);

function sessionMatches(pattern, umo) {
  if (!isPattern(pattern)) return pattern === umo;
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`).test(umo);
}

// 2 = 精确命中，1 = 通配符命中，0 = 未命中或被排除
function matchLevel(rule, umo) {
  const level = (list) => (list.some((s) => !isPattern(s) && s === umo) ? 2 : list.some((s) => sessionMatches(s, umo)) ? 1 : 0);
  const include = rule.sessions.filter((s) => !isExclude(s));
  const exclude = rule.sessions.filter(isExclude).map((s) => s.slice(1));
  return level(exclude) ? 0 : level(include);
}

const restrictsPlugins = (rule) => rule.mode === "whitelist" || rule.plugins.length > 0;
const modeTag = (rule, style) => (restrictsPlugins(rule) ? h("span", { class: `tag ${rule.mode}`, style }, MODE_TEXT[rule.mode]) : null);

const ruleAllows = (rule, name) => rule.plugins.includes(name) === (rule.mode === "whitelist");

function blockReason(name, matched) {
  for (const rule of matched) {
    if (!ruleAllows(rule, name)) {
      return rule.mode === "whitelist" ? `不在「${rule.name}」的允许列表里` : `被「${rule.name}」禁用`;
    }
  }
  const owners = draft.rules.filter((r) => r.enabled && r.exclusive.includes(name));
  if (owners.length && !owners.some((r) => matched.includes(r))) {
    return `专属于「${owners.map((r) => r.name).join("」「")}」的会话`;
  }
  return null;
}

// 每个设置项取最具体的规则：精确会话优先，同级时列表靠前的优先
function effectiveSettings(umo) {
  const ranked = draft.rules
    .map((rule, index) => ({ rule, index, level: rule.enabled ? matchLevel(rule, umo) : 0 }))
    .filter((r) => r.level)
    .sort((a, b) => b.level - a.level || a.index - b.index);
  const result = {};
  for (const { rule } of ranked) {
    for (const [key, value] of Object.entries(rule.overrides)) {
      if (!(key in result)) result[key] = { value, rule };
    }
  }
  return result;
}

// ---------- 状态 ----------

function cloneRule(r) {
  return {
    ...r,
    plugins: [...r.plugins],
    exclusive: [...(r.exclusive || [])],
    sessions: [...r.sessions],
    overrides: JSON.parse(JSON.stringify(r.overrides || {})),
  };
}

function setDraft(data) {
  draft = { settings: { ...data.settings }, rules: data.rules.map(cloneRule) };
  savedJson = JSON.stringify(draft);
  if (!selectedRule()) selectedId = draft.rules[0]?.id ?? null;
  renderAll();
}

function changed() {
  const dirty = JSON.stringify(draft) !== savedJson;
  $("dirty").hidden = !dirty;
  $("save").disabled = !dirty;
  $("reset").disabled = !dirty;
  renderTester();
}

function renderAll() {
  renderSettings();
  renderRuleList();
  renderEditor();
  changed();
}

// ---------- 全局设置 ----------

function renderSettings() {
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.checked = Boolean(draft.settings[input.dataset.setting]);
  }
}

for (const input of document.querySelectorAll("[data-setting]")) {
  input.addEventListener("change", () => {
    draft.settings[input.dataset.setting] = input.checked;
    changed();
  });
}

// ---------- 规则列表 ----------

function renderRuleList() {
  $("rule-list").replaceChildren(
    ...draft.rules.map((rule) => {
      const settingCount = Object.keys(rule.overrides).length;
      return h(
        "li",
        {
          class: `rule-item${rule.id === selectedId ? " active" : ""}${rule.enabled ? "" : " off"}`,
          onclick: () => {
            selectedId = rule.id;
            renderRuleList();
            renderEditor();
          },
        },
        h(
          "div",
          { class: "title" },
          h("span", {}, rule.name || "未命名规则"),
          rule.enabled ? modeTag(rule) : h("span", { class: "tag off" }, "已停用"),
        ),
        h(
          "small",
          {},
          [
            `${rule.sessions.length} 个会话`,
            `${rule.plugins.length} 个插件`,
            rule.exclusive.length ? `${rule.exclusive.length} 个专属` : "",
            settingCount ? `${settingCount} 项设置` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    }),
  );
  $("rule-empty").hidden = draft.rules.length > 0;
}

function addRule(rule) {
  draft.rules.push(rule);
  selectedId = rule.id;
  renderAll();
}

$("add-rule").addEventListener("click", () => {
  addRule({
    id: newId(),
    name: `规则 ${draft.rules.length + 1}`,
    mode: "blacklist",
    enabled: true,
    plugins: [],
    exclusive: [],
    sessions: [],
    overrides: {},
  });
});

// ---------- 原生规则迁移 ----------

$("import-native").addEventListener("click", async () => {
  try {
    const { rules } = await bridge.apiPost("import_native", {});
    if (!rules.length) {
      toast("原生自定义规则里没有可导入的内容");
      return;
    }
    draft.rules.push(...rules.map(cloneRule));
    selectedId = rules[0].id;
    renderAll();
    toast(`导入了 ${rules.length} 条规则，检查后记得保存`);
  } catch (error) {
    toast(`导入失败：${error.message}`, true);
  }
});

$("clear-native-slot").replaceWith(
  confirmButton("清除原生规则", "再点一次确认清除", async () => {
    try {
      const { count } = await bridge.apiPost("clear_native", {});
      toast(count ? `已清除 ${count} 个会话的原生规则` : "原生自定义规则已经是空的");
    } catch (error) {
      toast(`清除失败：${error.message}`, true);
    }
  }),
);

// ---------- 规则编辑器 ----------

function switchRow(checked, title, desc, onChange) {
  return h(
    "label",
    { class: "switch-row" },
    h("input", { type: "checkbox", checked, onchange: (e) => onChange(e.target.checked) }),
    h("span", { class: "switch" }),
    h("span", {}, h("b", {}, title), h("small", {}, desc)),
  );
}

function segmented(choices, current, onPick) {
  return h(
    "div",
    { class: "segmented small" },
    ...choices.map(([value, text, cls]) =>
      h(
        "button",
        {
          class: `${cls || ""}${value === current ? " on" : ""}`,
          disabled: choices.disabledValues?.includes(value),
          onclick: () => value !== current && onPick(value),
        },
        text,
      ),
    ),
  );
}

function ruleSummary(rule) {
  const sessions = rule.sessions.filter((s) => !isExclude(s)).length;
  if (!sessions) return "还没添加会话，这条规则暂时不会影响任何会话。";
  const parts = [];
  if (rule.mode === "whitelist") parts.push(`只能用勾选的 ${rule.plugins.length} 个插件，其余插件全部失效`);
  else if (rule.plugins.length) parts.push(`禁用勾选的 ${rule.plugins.length} 个插件`);
  if (rule.exclusive.length) {
    parts.push(`${rule.exclusive.map(pluginName).join("、")} 只能在这些会话里用`);
  }
  const settings = Object.entries(rule.overrides).map(
    ([key, value]) => `${SETTING_LABELS[key]}${typeof value === "boolean" ? "" : "："}${describeSetting(key, value)}`,
  );
  if (settings.length) parts.push(settings.join("，"));
  return parts.length ? `在这 ${sessions} 个会话里：${parts.join("；")}。` : `在这 ${sessions} 个会话里暂时什么都不改。`;
}

function renderEditor() {
  const editor = $("editor");
  const rule = selectedRule();
  if (!rule) {
    editor.replaceChildren(h("p", { class: "empty" }, "选中或新建一条规则开始编辑"));
    return;
  }

  const summary = h("div", { class: "summary" });
  const onEdit = (full = false) => {
    summary.textContent = ruleSummary(rule);
    renderRuleList();
    if (full) renderEditor();
    changed();
  };
  summary.textContent = ruleSummary(rule);

  const settingCount = Object.keys(rule.overrides).length;
  const tabs = h(
    "div",
    { class: "tabs" },
    ...[
      ["plugins", "插件", new Set([...rule.plugins, ...rule.exclusive]).size],
      ["settings", "会话设置", settingCount],
    ].map(([key, text, count]) =>
      h(
        "button",
        {
          class: `tab${editorTab === key ? " on" : ""}`,
          onclick: () => {
            editorTab = key;
            renderEditor();
          },
        },
        text,
        count ? h("span", { class: "badge" }, String(count)) : null,
      ),
    ),
  );

  editor.replaceChildren(
    summary,
    h(
      "div",
      { class: "field row-2" },
      h(
        "div",
        {},
        h("label", { class: "field-title", for: "rule-name" }, "规则名称"),
        h("input", {
          id: "rule-name",
          class: "input",
          value: rule.name,
          maxlength: "40",
          oninput: (e) => {
            rule.name = e.target.value;
            onEdit();
          },
        }),
      ),
      switchRow(rule.enabled, "启用", "停用后保留配置但不生效", (v) => {
        rule.enabled = v;
        onEdit();
      }),
    ),
    sessionField(rule, onEdit),
    tabs,
    editorTab === "plugins" ? pluginField(rule, onEdit) : settingsField(rule, onEdit),
    editorFoot(rule),
  );
}

function pluginField(rule, onEdit) {
  const count = h("span", { class: "muted" });
  const list = h("div", { class: "plugin-list" });

  const rows = () => {
    const known = new Set(plugins.map((p) => p.name));
    const missing = [...new Set([...rule.plugins, ...rule.exclusive])]
      .filter((name) => !known.has(name))
      .map((name) => ({ name, display_name: name, desc: "", missing: true }));
    const q = pluginQuery.toLowerCase();
    return [...plugins, ...missing].filter(
      (p) => !q || `${p.display_name} ${p.name} ${p.desc}`.toLowerCase().includes(q),
    );
  };

  const setIn = (key, name, on) => {
    const set = new Set(rule[key]);
    on ? set.add(name) : set.delete(name);
    rule[key] = [...set];
  };

  // 白名单：专属插件必须在允许列表里；黑名单：禁用和专属互斥
  const setChecked = (name, on) => {
    setIn("plugins", name, on);
    if (rule.mode === "whitelist" ? !on : on) setIn("exclusive", name, false);
  };
  const setExclusive = (name, on) => {
    setIn("exclusive", name, on);
    if (on) setIn("plugins", name, rule.mode === "whitelist");
  };

  const refresh = () => {
    const visible = rows();
    count.textContent = `已勾选 ${rule.plugins.length} / ${plugins.length}`;
    list.replaceChildren(
      ...visible.map((p) => {
        const exclusive = rule.exclusive.includes(p.name);
        return h(
          "div",
          { class: "plugin-row" },
          h(
            "label",
            { class: "plugin-check" },
            h("input", {
              type: "checkbox",
              checked: rule.plugins.includes(p.name),
              onchange: (e) => {
                setChecked(p.name, e.target.checked);
                update();
              },
            }),
            h(
              "div",
              { class: "meta" },
              h(
                "div",
                {},
                p.display_name,
                p.missing ? h("span", { class: "tag off" }, "未安装") : null,
                p.activated === false ? h("span", { class: "tag off" }, "未启用") : null,
              ),
              h("div", { class: "mono muted" }, p.name),
              p.desc ? h("div", { class: "desc", title: p.desc }, p.desc) : null,
            ),
          ),
          h(
            "button",
            {
              class: `lock${exclusive ? " on" : ""}`,
              title: "开启后，这个插件只能在本规则的会话里使用，其他会话一律失效",
              onclick: () => {
                setExclusive(p.name, !exclusive);
                update();
              },
            },
            exclusive ? "🔒 专属" : "专属",
          ),
        );
      }),
    );
    if (!visible.length) list.append(h("p", { class: "empty" }, "没有匹配的插件"));
  };

  const update = () => {
    refresh();
    onEdit();
  };

  const bulk = (fn) => () => {
    for (const p of rows()) setChecked(p.name, fn(rule.plugins.includes(p.name)));
    update();
  };

  refresh();
  return h(
    "div",
    { class: "field tab-body" },
    h(
      "div",
      { class: "field-title" },
      h("span", {}, count),
      segmented(
        Object.entries(MODE_OPTION).map(([mode, text]) => [mode, text, mode]),
        rule.mode,
        (mode) => {
          rule.mode = mode;
          // 切换模式时保持专属插件可用
          if (mode === "whitelist") rule.plugins = [...new Set([...rule.plugins, ...rule.exclusive])];
          else rule.plugins = rule.plugins.filter((n) => !rule.exclusive.includes(n));
          onEdit(true);
        },
      ),
    ),
    h(
      "div",
      { class: "row plugin-tools" },
      h("input", {
        class: "input",
        placeholder: "搜索插件名称、ID 或简介",
        value: pluginQuery,
        oninput: (e) => {
          pluginQuery = e.target.value;
          refresh();
        },
      }),
      h("button", { class: "btn ghost small", onclick: bulk(() => true) }, "全选"),
      h("button", { class: "btn ghost small", onclick: bulk(() => false) }, "清空"),
      h("button", { class: "btn ghost small", onclick: bulk((on) => !on) }, "反选"),
    ),
    list,
    h(
      "p",
      { class: "hint" },
      "「专属」：这个插件只能在本规则的会话里用，在其他所有会话里都失效。全选/清空/反选只作用于搜索结果。",
    ),
  );
}

function settingRow(rule, key, title, desc, control) {
  return h(
    "div",
    { class: `setting-row${key in rule.overrides ? " set" : ""}` },
    h("div", { class: "setting-label" }, h("b", {}, title), desc ? h("small", {}, desc) : null),
    control,
  );
}

function settingsField(rule, onEdit) {
  const set = (key, value) => {
    if (value === undefined) delete rule.overrides[key];
    else rule.overrides[key] = value;
    onEdit(true);
  };

  const select = (key, choices) => {
    // 设置过的值已经不存在（人格或模型被删了）时也要显示出来，避免误以为是默认
    const current = rule.overrides[key];
    if (current && !choices.some(([value]) => value === current)) choices.push([current, `${current}（不存在）`]);
    return h(
      "select",
      {
        class: "input select",
        disabled: choices.length <= 1,
        onchange: (e) => set(key, e.target.value || undefined),
      },
      ...choices.map(([value, text]) =>
        h("option", { value, selected: (rule.overrides[key] ?? "") === value }, text),
      ),
    );
  };

  const switches = SWITCHES.map(([key, title, desc]) =>
    settingRow(
      rule,
      key,
      title,
      desc,
      segmented(
        [
          ["default", "默认"],
          ["on", "开启", "whitelist"],
          ["off", "关闭", "blacklist"],
        ],
        key in rule.overrides ? (rule.overrides[key] ? "on" : "off") : "default",
        (v) => set(key, v === "default" ? undefined : v === "on"),
      ),
    ),
  );

  const persona = settingRow(
    rule,
    "persona",
    "人格",
    "强制使用的人格，会覆盖用户自己切换的人格",
    select("persona", [
      ["", "默认"],
      [NO_PERSONA, "不使用人格"],
      ...options.personas.map((name) => [name, name]),
    ]),
  );

  const providers = PROVIDERS.map(([key, title, optionKey]) =>
    settingRow(
      rule,
      key,
      title,
      options[optionKey].length ? "" : "还没有配置这类模型",
      select(key, [["", "默认"], ...options[optionKey].map((p) => [p.id, p.model ? `${p.id}（${p.model}）` : p.id])]),
    ),
  );

  return h(
    "div",
    { class: "field tab-body" },
    h("p", { class: "hint top" }, "「默认」表示不改动，沿用 AstrBot 的配置。改过的项会高亮。"),
    h("div", { class: "setting-group" }, h("div", { class: "group-title" }, "开关"), ...switches),
    h("div", { class: "setting-group" }, h("div", { class: "group-title" }, "人格与模型"), persona, ...providers),
    h("div", { class: "setting-group" }, h("div", { class: "group-title" }, "知识库"), kbSetting(rule, set)),
  );
}

function kbSetting(rule, set) {
  const kb = rule.overrides.kb;
  const mode = !kb ? "default" : kb.ids.length ? "pick" : "none";
  const choices = [
    ["default", "默认"],
    ["none", "不使用", "blacklist"],
    ["pick", "指定知识库", "whitelist"],
  ];
  choices.disabledValues = options.kbs.length ? [] : ["pick"];

  const control = segmented(choices, mode, (v) => {
    if (v === "default") set("kb", undefined);
    else if (v === "none") set("kb", { ids: [], top_k: kb?.top_k ?? null });
    else set("kb", { ids: [options.kbs[0].id], top_k: kb?.top_k ?? null });
  });

  const body =
    mode === "pick"
      ? h(
          "div",
          { class: "kb-pick" },
          h(
            "div",
            { class: "kb-list" },
            ...[
              ...options.kbs,
              ...kb.ids
                .filter((id) => !options.kbs.some((item) => item.id === id))
                .map((id) => ({ id, name: `${id}（不存在）`, emoji: "" })),
            ].map((item) => {
              const checked = kb.ids.includes(item.id);
              return h(
                "label",
                { class: `kb-chip${checked ? " on" : ""}` },
                h("input", {
                  type: "checkbox",
                  checked,
                  // 至少保留一个，全部取消请选「不使用」
                  disabled: checked && kb.ids.length === 1,
                  onchange: (e) => {
                    const ids = e.target.checked ? [...kb.ids, item.id] : kb.ids.filter((id) => id !== item.id);
                    set("kb", { ...kb, ids });
                  },
                }),
                `${item.emoji} ${item.name}`.trim(),
              );
            }),
          ),
          h(
            "label",
            { class: "kb-topk" },
            "检索条数",
            h("input", {
              class: "input",
              type: "number",
              min: "1",
              max: "50",
              placeholder: "默认",
              value: kb.top_k ?? "",
              onchange: (e) => {
                const n = parseInt(e.target.value, 10);
                set("kb", { ...kb, top_k: Number.isFinite(n) ? Math.min(Math.max(n, 1), 50) : null });
              },
            }),
          ),
        )
      : null;

  return h(
    "div",
    {},
    settingRow(rule, "kb", "使用的知识库", options.kbs.length ? "" : "还没有创建知识库", control),
    body,
  );
}

function sessionField(rule, onEdit) {
  const chips = h("div", { class: "chips" });
  const suggestions = h("div", { class: "suggestions", hidden: true });
  let highlighted = -1;
  let choices = [];

  const input = h("input", {
    class: "input",
    placeholder: "按群名 / 会话 ID 搜索，或直接输入后回车",
    oninput: () => showSuggestions(),
    onfocus: () => showSuggestions(),
    onblur: () => (suggestions.hidden = true),
    onkeydown: (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!choices.length) return;
        highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
        [...suggestions.children].forEach((el, i) => el.classList.toggle("hl", i === highlighted));
        suggestions.children[highlighted]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        add(highlighted >= 0 ? choices[highlighted].umo : input.value);
      } else if (e.key === "Escape") {
        suggestions.hidden = true;
      }
    },
  });

  function add(value) {
    const umo = value.trim();
    if (!umo || umo === "!") return;
    if (!rule.sessions.includes(umo)) rule.sessions.push(umo);
    input.value = "";
    suggestions.hidden = true;
    update();
  }

  function showSuggestions() {
    const q = input.value.trim().toLowerCase();
    choices = [...sessionNames]
      .filter(([umo, name]) => !rule.sessions.includes(umo) && (!q || `${umo} ${name}`.toLowerCase().includes(q)))
      .slice(0, 50)
      .map(([umo, name]) => ({ umo, name }));
    highlighted = -1;
    suggestions.replaceChildren(
      ...choices.map((opt) =>
        h(
          "div",
          {
            class: "suggestion",
            // mousedown 先于 blur，防止点选前下拉就收起
            onmousedown: (e) => {
              e.preventDefault();
              add(opt.umo);
            },
          },
          h("div", {}, opt.name || "未命名会话"),
          h("div", { class: "mono muted" }, opt.umo),
        ),
      ),
    );
    suggestions.hidden = !choices.length;
  }

  function label(entry) {
    const umo = isExclude(entry) ? entry.slice(1) : entry;
    const name = isPattern(umo) ? "通配符" : sessionNames.get(umo) || "未命名会话";
    return isExclude(entry) ? [h("span", { class: "tag blacklist" }, "排除"), " ", name] : [name];
  }

  function refresh() {
    chips.replaceChildren(
      ...rule.sessions.map((entry) =>
        h(
          "div",
          { class: "chip" },
          h("div", { class: "meta" }, h("div", {}, ...label(entry)), h("div", { class: "mono muted" }, entry)),
          h(
            "button",
            {
              class: "x",
              title: "移除",
              onclick: () => {
                rule.sessions = rule.sessions.filter((s) => s !== entry);
                update();
              },
            },
            "×",
          ),
        ),
      ),
    );
    if (!rule.sessions.length) chips.append(h("p", { class: "empty" }, "还没有会话"));
  }

  function update() {
    refresh();
    onEdit();
  }

  refresh();
  return h(
    "div",
    { class: "field" },
    h(
      "div",
      { class: "field-title" },
      h("span", {}, "生效会话 ", h("span", { class: "muted" }, `${rule.sessions.length} 个`)),
      h(
        "div",
        { class: "row" },
        ...QUICK_PATTERNS.map(([text, pattern]) =>
          h("button", { class: "btn ghost small", title: pattern, onclick: () => add(pattern) }, `+ ${text}`),
        ),
      ),
    ),
    chips,
    h("div", { class: "picker" }, input, suggestions),
    h(
      "p",
      { class: "hint" },
      "会话 ID 可在聊天里发 /sid 获取。* 匹配任意字符、? 匹配单个字符；在前面加 ! 表示排除，例如 + 所有群聊 再加 !某个群。",
    ),
  );
}

function editorFoot(rule) {
  const index = draft.rules.indexOf(rule);
  const move = (offset) => () => {
    const [item] = draft.rules.splice(index, 1);
    draft.rules.splice(index + offset, 0, item);
    renderAll();
  };
  const remove = confirmButton("删除规则", "再点一次确认删除", () => {
    draft.rules.splice(index, 1);
    selectedId = draft.rules[Math.max(0, index - 1)]?.id ?? null;
    renderAll();
  });

  return h(
    "div",
    { class: "editor-foot" },
    h(
      "div",
      { class: "row" },
      h("button", { class: "btn ghost small", disabled: index === 0, onclick: move(-1), title: "设置项冲突时靠前的规则优先" }, "上移"),
      h("button", { class: "btn ghost small", disabled: index === draft.rules.length - 1, onclick: move(1) }, "下移"),
      h(
        "button",
        {
          class: "btn ghost small",
          onclick: () => addRule({ ...cloneRule(rule), id: newId(), name: `${rule.name} 副本`, exclusive: [], sessions: [] }),
        },
        "复制为新规则",
      ),
    ),
    remove,
  );
}

// ---------- 命中测试 ----------

function renderTester() {
  const out = $("test-result");
  const umo = $("test-umo").value.trim();
  if (!umo) {
    out.className = "test-result muted";
    out.replaceChildren("输入会话 ID，看看这个会话里哪些插件能用、生效的是哪些设置");
    return;
  }
  out.className = "test-result";
  const matched = draft.rules.filter((r) => r.enabled && matchLevel(r, umo));
  const results = plugins.map((p) => ({ p, reason: blockReason(p.name, matched) }));
  const allowed = results.filter((r) => !r.reason);
  const blocked = results.filter((r) => r.reason);
  const settings = Object.entries(effectiveSettings(umo));

  out.replaceChildren(
    h(
      "div",
      {},
      draft.settings.enabled ? null : h("div", { class: "warn" }, "⚠ 总开关已关闭，规则暂不生效"),
      h(
        "div",
        {},
        "命中规则：",
        matched.length
          ? matched.map((r) => [h("b", {}, r.name), modeTag(r, "margin-left: 4px"), "　"])
          : h("span", { class: "muted" }, "无"),
      ),
      h("div", { class: "test-section" }, `可用插件 ${allowed.length} / ${plugins.length}（系统插件始终可用）`),
      h("div", { class: "plugins" }, ...allowed.map(({ p }) => h("span", { class: "pill" }, p.display_name))),
      blocked.length
        ? h(
            "div",
            { class: "blocked" },
            ...blocked.map(({ p, reason }) => h("div", {}, h("span", { class: "pill off" }, p.display_name), h("span", { class: "muted" }, reason))),
          )
        : null,
      h("div", { class: "test-section" }, "会话设置"),
      settings.length
        ? h(
            "div",
            { class: "blocked" },
            ...settings.map(([key, { value, rule }]) =>
              h("div", {}, h("b", {}, `${SETTING_LABELS[key]}：`), describeSetting(key, value), h("span", { class: "muted" }, `　来自「${rule.name}」`)),
            ),
          )
        : h("div", { class: "muted" }, "全部默认，沿用 AstrBot 配置"),
    ),
  );
}

$("test-umo").addEventListener("input", renderTester);

// ---------- 保存 / 撤销 ----------

$("save").addEventListener("click", async () => {
  $("save").disabled = true;
  try {
    setDraft(await bridge.apiPost("save", draft));
    toast("已保存，立即生效");
  } catch (error) {
    toast(`保存失败：${error.message}`, true);
    changed();
  }
});

$("reset").addEventListener("click", () => setDraft(JSON.parse(savedJson)));

// ---------- 初始化 ----------

try {
  await bridge.ready();
  const state = await bridge.apiGet("state");
  plugins = state.plugins;
  options = state.options;
  sessionNames = new Map(state.sessions.map((s) => [s.umo, s.name]));
  $("session-options").replaceChildren(
    ...state.sessions.map((s) => h("option", { value: s.umo }, s.name || s.umo)),
  );
  setDraft(state);
} catch (error) {
  toast(`加载失败：${error.message}`, true);
}
