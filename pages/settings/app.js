const bridge = window.AstrBotPluginView || window.AstrBotPluginPage;

const MODE_TEXT = { whitelist: "白名单", blacklist: "黑名单" };
const MODE_HINT = {
  whitelist: "只有勾选的插件能在这些会话里响应，其余插件全部屏蔽。",
  blacklist: "勾选的插件在这些会话里被屏蔽，其余插件照常工作。",
};
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

// ---------- 规则匹配（与后端 rules.py 保持一致） ----------

const isPattern = (s) => /[*?]/.test(s);

function patternRegex(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

function matchRule(umo) {
  const rules = draft.rules.filter((r) => r.enabled);
  for (const rule of rules) {
    if (rule.sessions.some((s) => !isPattern(s) && s === umo)) return [rule, "精确匹配"];
  }
  for (const rule of rules) {
    const hit = rule.sessions.find((s) => isPattern(s) && patternRegex(s).test(umo));
    if (hit) return [rule, `通配符 ${hit}`];
  }
  return [null, ""];
}

const allows = (rule, name) => rule.plugins.includes(name) === (rule.mode === "whitelist");
const selectedRule = () => draft.rules.find((r) => r.id === selectedId);

// ---------- 状态 ----------

function setDraft(data) {
  draft = {
    settings: { ...data.settings },
    rules: data.rules.map((r) => ({ ...r, plugins: [...r.plugins], sessions: [...r.sessions] })),
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
  const list = $("rule-list");
  list.replaceChildren(
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
        h("small", {}, `${rule.plugins.length} 个插件 · ${rule.sessions.length} 个会话`),
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
    id: Math.random().toString(16).slice(2, 10),
    name: `规则 ${draft.rules.length + 1}`,
    mode: "whitelist",
    enabled: true,
    strict: true,
    plugins: [],
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

function renderEditor() {
  const editor = $("editor");
  const rule = selectedRule();
  if (!rule) {
    editor.replaceChildren(h("p", { class: "empty" }, "选中或新建一条规则开始编辑"));
    return;
  }

  const update = (patch, full = false) => {
    Object.assign(rule, patch);
    renderRuleList();
    if (full) renderEditor();
    changed();
  };

  editor.replaceChildren(
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-title", for: "rule-name" }, "规则名称"),
      h("input", {
        id: "rule-name",
        class: "input",
        value: rule.name,
        maxlength: "40",
        oninput: (e) => update({ name: e.target.value }),
      }),
    ),
    h(
      "div",
      { class: "field" },
      switchRow(rule.enabled, "启用这条规则", "停用后保留配置，但不再参与匹配", (v) => update({ enabled: v })),
    ),
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-title" }, "过滤模式"),
      h(
        "div",
        { class: "segmented" },
        ...Object.entries(MODE_TEXT).map(([mode, text]) =>
          h(
            "button",
            {
              class: `${mode}${rule.mode === mode ? " on" : ""}`,
              onclick: () => update({ mode }, true),
            },
            text,
          ),
        ),
      ),
      h("p", { class: "hint" }, MODE_HINT[rule.mode]),
    ),
    h(
      "div",
      { class: "field" },
      switchRow(
        rule.strict,
        "严格模式",
        "同时屏蔽被拦插件的事件钩子（LLM 请求前后、发送前装饰等）和 LLM 函数工具；关闭后只拦指令和消息监听，跟原生规则一样",
        (v) => update({ strict: v }),
      ),
    ),
    pluginField(rule),
    sessionField(rule),
    editorFoot(rule),
  );
}

function pluginField(rule) {
  const count = h("span", { class: "muted" });
  const warn = h("p", { class: "hint", style: "color: var(--warn)" });
  const list = h("div", { class: "plugin-list" });

  const rows = () => {
    const known = new Set(plugins.map((p) => p.name));
    const missing = rule.plugins
      .filter((name) => !known.has(name))
      .map((name) => ({ name, display_name: name, desc: "", missing: true }));
    const q = pluginQuery.toLowerCase();
    return [...plugins, ...missing].filter(
      (p) => !q || `${p.display_name} ${p.name} ${p.desc}`.toLowerCase().includes(q),
    );
  };

  const toggle = (name, on) => {
    const set = new Set(rule.plugins);
    on ? set.add(name) : set.delete(name);
    rule.plugins = [...set];
  };

  const refresh = () => {
    const visible = rows();
    count.textContent = `已勾选 ${rule.plugins.length} / ${plugins.length}`;
    warn.hidden = !(rule.mode === "whitelist" && rule.plugins.length === 0);
    warn.textContent = "白名单还是空的：这些会话里除系统插件外的插件都会被屏蔽";
    list.replaceChildren(
      ...visible.map((p) =>
        h(
          "label",
          { class: "plugin-row" },
          h("input", {
            type: "checkbox",
            checked: rule.plugins.includes(p.name),
            onchange: (e) => {
              toggle(p.name, e.target.checked);
              onEdit();
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
      ),
    );
    if (!visible.length) list.append(h("p", { class: "empty" }, "没有匹配的插件"));
  };

  const onEdit = () => {
    refresh();
    renderRuleList();
    changed();
  };

  const bulk = (fn) => () => {
    for (const p of rows()) toggle(p.name, fn(rule.plugins.includes(p.name)));
    onEdit();
  };

  refresh();
  return h(
    "div",
    { class: "field" },
    h(
      "div",
      { class: "field-title" },
      h("span", {}, rule.mode === "whitelist" ? "放行的插件 " : "屏蔽的插件 ", count),
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn ghost small", onclick: bulk(() => true) }, "全选"),
        h("button", { class: "btn ghost small", onclick: bulk(() => false) }, "清空"),
        h("button", { class: "btn ghost small", onclick: bulk((on) => !on) }, "反选"),
      ),
    ),
    h("input", {
      class: "input",
      placeholder: "搜索插件名称、ID 或简介（全选/清空/反选只作用于搜索结果）",
      value: pluginQuery,
      oninput: (e) => {
        pluginQuery = e.target.value;
        refresh();
      },
    }),
    warn,
    list,
  );
}

function sessionField(rule) {
  const chips = h("div", { class: "chips" });
  const suggestions = h("div", { class: "suggestions", hidden: true });
  let highlighted = -1;
  let options = [];

  const input = h("input", {
    class: "input",
    placeholder: "搜索已知会话，或直接输入会话 ID / 通配符后回车",
    oninput: () => showSuggestions(),
    onfocus: () => showSuggestions(),
    onblur: () => (suggestions.hidden = true),
    onkeydown: (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!options.length) return;
        highlighted = (highlighted + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        paintHighlight();
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
    if (!umo) return;
    if (!rule.sessions.includes(umo)) rule.sessions.push(umo);
    input.value = "";
    suggestions.hidden = true;
    onEdit();
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

  function paintHighlight() {
    [...suggestions.children].forEach((el, i) => el.classList.toggle("hl", i === highlighted));
    suggestions.children[highlighted]?.scrollIntoView({ block: "nearest" });
  }

  function refresh() {
    chips.replaceChildren(
      ...rule.sessions.map((umo) =>
        h(
          "div",
          { class: "chip" },
          h(
            "div",
            { class: "meta" },
            h("div", {}, isPattern(umo) ? "通配符" : sessionNames.get(umo) || "未命名会话"),
            h("div", { class: "mono muted" }, umo),
          ),
          h(
            "button",
            {
              class: "x",
              title: "移除",
              onclick: () => {
                rule.sessions = rule.sessions.filter((s) => s !== umo);
                onEdit();
              },
            },
            "×",
          ),
        ),
      ),
    );
    if (!rule.sessions.length) chips.append(h("p", { class: "empty" }, "还没有会话，规则不会命中任何地方"));
  }

  function onEdit() {
    refresh();
    renderRuleList();
    changed();
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
      "会话 ID 可以在聊天里发 /sid 获取。通配符 * 匹配任意字符、? 匹配单个字符；同一会话命中多条规则时，精确会话优先于通配符，其次按列表顺序。",
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
      h("button", { class: "btn ghost small", disabled: index === 0, onclick: move(-1) }, "上移"),
      h("button", { class: "btn ghost small", disabled: index === draft.rules.length - 1, onclick: move(1) }, "下移"),
      h(
        "button",
        {
          class: "btn ghost small",
          onclick: () =>
            addRule({
              ...rule,
              id: Math.random().toString(16).slice(2, 10),
              name: `${rule.name} 副本`,
              plugins: [...rule.plugins],
              sessions: [],
            }),
        },
        "复制",
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
    out.replaceChildren("输入会话 ID 看看会命中哪条规则");
    return;
  }
  out.className = "test-result";
  const [rule, via] = matchRule(umo);
  const notes = [];
  if (!draft.settings.enabled) notes.push(h("div", { class: "muted" }, "⚠ 总开关已关闭，规则暂不生效"));
  if (!rule) {
    out.replaceChildren(...notes, h("div", {}, "没有命中规则，所有插件照常响应"));
    return;
  }
  const allowed = plugins.filter((p) => allows(rule, p.name));
  out.replaceChildren(
    ...notes,
    h(
      "div",
      {},
      "命中「",
      h("b", {}, rule.name),
      "」",
      h("span", { class: `tag ${rule.mode}`, style: "margin: 0 6px" }, MODE_TEXT[rule.mode]),
      h("span", { class: "muted" }, `（${via}${rule.strict ? "，严格模式" : ""}）`),
    ),
    h("div", { class: "muted", style: "margin-top: 6px" }, `可用插件 ${allowed.length} / ${plugins.length}（系统插件始终可用）`),
    h("div", { class: "plugins" }, ...allowed.map((p) => h("span", { class: "pill" }, p.display_name))),
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
  sessionNames = new Map(state.sessions.map((s) => [s.umo, s.name]));
  $("session-options").replaceChildren(
    ...state.sessions.map((s) => h("option", { value: s.umo }, s.name || s.umo)),
  );
  setDraft(state);
} catch (error) {
  toast(`加载失败：${error.message}`, true);
}
