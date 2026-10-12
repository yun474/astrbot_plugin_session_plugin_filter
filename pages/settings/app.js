const bridge = window.AstrBotPluginView || window.AstrBotPluginPage;

const MODE_TEXT = { whitelist: "白名单", blacklist: "黑名单" };
const MODE_OPTION = { whitelist: "只允许勾选的插件", blacklist: "禁用勾选的插件" };
const QUICK_PATTERNS = [
  ["所有群聊", "*:GroupMessage:*"],
  ["所有私聊", "*:FriendMessage:*"],
];

let plugins = [];
let sessionNames = new Map();
let draft = { settings: {}, rules: [] };
let savedJson = "";
let selectedId = null;
let pluginQuery = "";

const $ = (id) => document.getElementById(id);
const DOM_PROPS = new Set(["checked", "disabled", "hidden", "value"]);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (DOM_PROPS.has(key)) el[key] = value;
    else if (value != null) el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
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

const newId = () => Math.random().toString(16).slice(2, 10);
const pluginName = (name) => plugins.find((p) => p.name === name)?.display_name || name;
const selectedRule = () => draft.rules.find((r) => r.id === selectedId);

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

function covers(rule, umo) {
  const hit = (list) => list.some((s) => sessionMatches(s, umo));
  const include = rule.sessions.filter((s) => !isExclude(s));
  const exclude = rule.sessions.filter(isExclude).map((s) => s.slice(1));
  return hit(include) && !hit(exclude);
}

const ruleAllows = (rule, name) => rule.plugins.includes(name) === (rule.mode === "whitelist");

// 返回拦截原因，放行时返回 null
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

// ---------- 状态 ----------

function setDraft(data) {
  draft = {
    settings: { ...data.settings },
    rules: data.rules.map((r) => ({
      ...r,
      plugins: [...r.plugins],
      exclusive: [...(r.exclusive || [])],
      sessions: [...r.sessions],
    })),
  };
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
    ...draft.rules.map((rule) =>
      h(
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
          rule.enabled
            ? h("span", { class: `tag ${rule.mode}` }, MODE_TEXT[rule.mode])
            : h("span", { class: "tag off" }, "已停用"),
        ),
        h(
          "small",
          {},
          [
            `${rule.sessions.length} 个会话`,
            `${rule.plugins.length} 个插件`,
            rule.exclusive.length ? `${rule.exclusive.length} 个专属` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      ),
    ),
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
    mode: "whitelist",
    enabled: true,
    plugins: [],
    exclusive: [],
    sessions: [],
  });
});

$("import-native").addEventListener("click", async () => {
  try {
    const { rules } = await bridge.apiPost("import_native", {});
    if (!rules.length) {
      toast("原生自定义规则里没有禁用插件的配置");
      return;
    }
    draft.rules.push(...rules);
    selectedId = rules[0].id;
    renderAll();
    toast(`导入了 ${rules.length} 条规则，记得保存`);
  } catch (error) {
    toast(`导入失败：${error.message}`, true);
  }
});

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

function ruleSummary(rule) {
  const sessions = rule.sessions.filter((s) => !isExclude(s)).length;
  if (!sessions) return "还没添加会话，这条规则暂时不会限制任何会话里的插件。";
  const where = `在这 ${sessions} 个会话里`;
  const main =
    rule.mode === "whitelist"
      ? `${where}只能用勾选的 ${rule.plugins.length} 个插件，其余插件全部失效`
      : rule.plugins.length
        ? `${where}禁用勾选的 ${rule.plugins.length} 个插件`
        : `${where}不限制插件`;
  const exclusive = rule.exclusive.length
    ? `；${rule.exclusive.map(pluginName).join("、")} 只能在这些会话里用，别的会话都用不了`
    : "";
  return `${main}${exclusive}。`;
}

function renderEditor() {
  const editor = $("editor");
  const rule = selectedRule();
  if (!rule) {
    editor.replaceChildren(h("p", { class: "empty" }, "选中或新建一条规则开始编辑"));
    return;
  }

  const summary = h("div", { class: "summary" });
  const refreshSummary = () => (summary.textContent = ruleSummary(rule));
  const onEdit = (full = false) => {
    refreshSummary();
    renderRuleList();
    if (full) renderEditor();
    changed();
  };
  refreshSummary();

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
    pluginField(rule, onEdit),
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
    { class: "field" },
    h(
      "div",
      { class: "field-title" },
      h("span", {}, "插件 ", count),
      h(
        "div",
        { class: "segmented" },
        ...Object.entries(MODE_OPTION).map(([mode, text]) =>
          h(
            "button",
            {
              class: `${mode}${rule.mode === mode ? " on" : ""}`,
              onclick: () => {
                if (rule.mode === mode) return;
                rule.mode = mode;
                // 切换模式时保持专属插件可用
                if (mode === "whitelist") rule.plugins = [...new Set([...rule.plugins, ...rule.exclusive])];
                else rule.plugins = rule.plugins.filter((n) => !rule.exclusive.includes(n));
                onEdit(true);
              },
            },
            text,
          ),
        ),
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

function sessionField(rule, onEdit) {
  const chips = h("div", { class: "chips" });
  const suggestions = h("div", { class: "suggestions", hidden: true });
  let highlighted = -1;
  let options = [];

  const input = h("input", {
    class: "input",
    placeholder: "按群名 / 会话 ID 搜索，或直接输入后回车",
    oninput: () => showSuggestions(),
    onfocus: () => showSuggestions(),
    onblur: () => (suggestions.hidden = true),
    onkeydown: (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!options.length) return;
        highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        [...suggestions.children].forEach((el, i) => el.classList.toggle("hl", i === highlighted));
        suggestions.children[highlighted]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        add(highlighted >= 0 ? options[highlighted].umo : input.value);
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
    options = [...sessionNames]
      .filter(([umo, name]) => !rule.sessions.includes(umo) && (!q || `${umo} ${name}`.toLowerCase().includes(q)))
      .slice(0, 50)
      .map(([umo, name]) => ({ umo, name }));
    highlighted = -1;
    suggestions.replaceChildren(
      ...options.map((opt) =>
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
    suggestions.hidden = !options.length;
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
  const remove = h("button", { class: "btn ghost small danger" }, "删除规则");
  remove.addEventListener("click", () => {
    // iframe 沙箱里没有 confirm()，用二次点击确认
    if (!remove.dataset.armed) {
      remove.dataset.armed = "1";
      remove.textContent = "再点一次确认删除";
      setTimeout(() => {
        delete remove.dataset.armed;
        remove.textContent = "删除规则";
      }, 3000);
      return;
    }
    const index = draft.rules.indexOf(rule);
    draft.rules.splice(index, 1);
    selectedId = draft.rules[Math.max(0, index - 1)]?.id ?? null;
    renderAll();
  });

  return h(
    "div",
    { class: "editor-foot" },
    h(
      "button",
      {
        class: "btn ghost small",
        onclick: () =>
          addRule({
            ...rule,
            id: newId(),
            name: `${rule.name} 副本`,
            plugins: [...rule.plugins],
            exclusive: [],
            sessions: [],
          }),
      },
      "复制为新规则",
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
    out.replaceChildren("输入会话 ID 看看这个会话里哪些插件能用");
    return;
  }
  out.className = "test-result";
  const matched = draft.rules.filter((r) => r.enabled && covers(r, umo));
  const results = plugins.map((p) => ({ p, reason: blockReason(p.name, matched) }));
  const allowed = results.filter((r) => !r.reason);
  const blocked = results.filter((r) => r.reason);

  out.replaceChildren(h("div", {},
    draft.settings.enabled ? null : h("div", { class: "warn" }, "⚠ 总开关已关闭，规则暂不生效"),
    h(
      "div",
      {},
      "命中规则：",
      matched.length
        ? matched.map((r) => [h("b", {}, r.name), h("span", { class: `tag ${r.mode}`, style: "margin: 0 8px 0 4px" }, MODE_TEXT[r.mode])])
        : h("span", { class: "muted" }, "无"),
    ),
    h("div", { class: "muted", style: "margin-top: 8px" }, `可用插件 ${allowed.length} / ${plugins.length}（系统插件始终可用）`),
    h("div", { class: "plugins" }, ...allowed.map(({ p }) => h("span", { class: "pill" }, p.display_name))),
    blocked.length
      ? h(
          "div",
          { class: "blocked" },
          h("div", { class: "muted" }, `被拦插件 ${blocked.length}`),
          ...blocked.map(({ p, reason }) => h("div", {}, h("span", { class: "pill off" }, p.display_name), h("span", { class: "muted" }, reason))),
        )
      : null,
  ));
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
  sessionNames = new Map(state.sessions.map((s) => [s.umo, s.name]));
  $("session-options").replaceChildren(
    ...state.sessions.map((s) => h("option", { value: s.umo }, s.name || s.umo)),
  );
  setDraft(state);
} catch (error) {
  toast(`加载失败：${error.message}`, true);
}
