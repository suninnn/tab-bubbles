// Side panel: draw every open tab as an equal-size square tile, coloured by idle time.
const $ = id => document.getElementById(id);
let state = null;
let marking = null;

const SIGNAL_TEXT = {
  "otp": "verification code waiting",
  "half-form": "form half filled in",
  "unsaved-text": "text not sent yet",
  "flow-page": "checkout / application page"
};

// Three flat colours: light green (fresh), light yellow (cooling off), light red (idle).
// Red starts at the idle setting (default 1 h), so it matches the badge and "Idle only".
function bands() {
  const idle = state.settings.idleMinutes;
  return { fresh: Math.min(15, Math.max(1, Math.round(idle / 2))), idle };
}
function bandOf(t) {
  if (t.active) return 0;
  const m = t.idleMs / 60000, b = bands();
  return m < b.fresh ? 0 : m < b.idle ? 1 : 2;
}
function mins(m) { return m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m > 1440 ? "s" : ""}` : m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`; }
function renderLegend() {
  const b = bands();
  const labels = [`Fresh (< ${mins(b.fresh)})`, `${mins(b.fresh)} – ${mins(b.idle)}`, `Idle (> ${mins(b.idle)})`];
  const el = $("legend"); el.innerHTML = "";
  labels.forEach((text, i) => {
    const item = document.createElement("span");
    const dot = document.createElement("i"); dot.className = `band-${i}`;
    item.append(dot, document.createTextNode(text)); el.append(item);
  });
}

async function load() {
  state = await chrome.runtime.sendMessage({ type: "tb-state" });
  // Never show the extension's own pages as bubbles.
  state.tabs = state.tabs.filter(t => !(t.url || "").startsWith(chrome.runtime.getURL("")));
  const s = state.settings;
  $("idleMinutes").value = s.idleMinutes;
  $("taskRemindMinutes").value = s.taskRemindMinutes;
  $("notify").checked = s.notify;
  const { ui } = await chrome.storage.local.get("ui");
  if (ui) { $("groupBy").value = ui.groupBy || "window"; $("idleOnly").checked = !!ui.idleOnly; }
  render();
}

function isIdle(t) { return !t.active && t.idleMs >= state.settings.idleMinutes * 60000; }

function render() {
  renderLegend();
  const tabs = state.tabs;
  const idle = tabs.filter(isIdle);
  const tasks = tabs.filter(t => t.task);
  const windows = new Set(tabs.map(t => t.windowId)).size;
  $("summary").textContent = `${tabs.length} tabs · ${windows} window${windows > 1 ? "s" : ""} · ${idle.length} idle`;

  // Unfinished tasks panel
  $("tasks").hidden = !tasks.length;
  const list = $("taskList"); list.innerHTML = "";
  for (const t of tasks.sort((a, b) => b.idleMs - a.idleMs)) {
    const li = document.createElement("li");
    const what = t.task.kind === "manual"
      ? (t.task.note || "marked as a task")
      : t.task.signals.map(s => SIGNAL_TEXT[s]).filter(Boolean).join(", ");
    li.innerHTML = `<div class="what"><b></b><span></span></div>`;
    li.querySelector("b").textContent = t.title || tbDomain(t.url);
    li.querySelector("span").textContent =
      `${what} · left ${tbAgo(t.idleMs)}` + (t.openedAt ? ` · opened ${t.openedKnown ? "" : "≥ "}${tbAgo(state.now - t.openedAt)}` : "");
    const go = btn("Go", () => focusTab(t));
    const done = btn("Done", async () => { await chrome.runtime.sendMessage({ type: "tb-unmark", tabId: t.id }); load(); });
    done.title = "Not a task any more (keeps the tab open)";
    li.append(go, done);
    list.append(li);
  }

  // Bubbles
  const shown = $("idleOnly").checked ? tabs.filter(t => isIdle(t) || t.task) : tabs;
  const groupBy = $("groupBy").value;
  const groups = new Map();
  let wi = 0; const wname = new Map();
  for (const t of shown) {
    let key = "All tabs";
    if (groupBy === "window") {
      if (!wname.has(t.windowId)) wname.set(t.windowId, `Window ${++wi}`);
      key = wname.get(t.windowId);
    } else if (groupBy === "domain") key = tbDomain(t.url) || "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const main = $("groups"); main.innerHTML = "";
  if (!shown.length) { main.innerHTML = `<div class="empty">Nothing idle. Nice and tidy.</div>`; return; }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, items] of ordered) {
    const g = document.createElement("section"); g.className = "group glass";
    const h = document.createElement("h3"); h.textContent = `${name} · ${items.length}`; g.append(h);
    const field = document.createElement("div"); field.className = "field";
    field._items = items.sort((a, b) => b.idleMs - a.idleMs);
    g.append(field); main.append(g);
  }
  layoutFields();
}

// Tiles: every tab is an equal-size square in an even grid (CSS grid fills the panel width).
function layoutFields() {
  for (const field of document.querySelectorAll(".field")) {
    field.innerHTML = "";
    for (const t of field._items || []) field.append(bubble(t));
  }
}

function bubble(t) {
  const b = document.createElement("div");
  b.className = `bubble band-${bandOf(t)}` + (t.active ? " active" : "") + (t.task ? " task" : "");
  b.title = `${t.title}\n${t.url}\nLast viewed ${t.active ? "now" : tbAgo(t.idleMs)}` +
    (t.openedAt ? `\nOpened ${t.openedKnown ? "" : "at least "}${tbAgo(state.now - t.openedAt)}` : "");

  if (t.favIconUrl && /^(https?:|data:)/.test(t.favIconUrl)) {
    const img = document.createElement("img"); img.src = t.favIconUrl; img.alt = ""; img.onerror = () => img.remove(); b.append(img);
  }
  const title = document.createElement("div"); title.className = "t"; title.textContent = (t.title || tbDomain(t.url)).slice(0, 40); b.append(title);
  { const age = document.createElement("div"); age.className = "age"; age.textContent = t.active ? "now" : tbDur(t.idleMs); b.append(age); }
  if (t.task) { const f = document.createElement("div"); f.className = "flag"; f.textContent = "!"; b.append(f); }

  const x = document.createElement("button"); x.className = "x"; x.textContent = "×"; x.title = "Pop (close this tab)";
  x.onclick = e => { e.stopPropagation(); pop(t, b); };
  const pin = document.createElement("button"); pin.className = "pin"; pin.textContent = t.task ? "✓" : "📌";
  pin.title = t.task ? "Not a task any more" : "Mark as unfinished task";
  pin.onclick = async e => {
    e.stopPropagation();
    if (t.task) { await chrome.runtime.sendMessage({ type: "tb-unmark", tabId: t.id }); load(); }
    else openMark(t);
  };
  // Buttons sit INSIDE the circle so moving the mouse to them never leaves the hover area.
  const acts = document.createElement("div"); acts.className = "acts"; acts.append(pin, x);
  b.append(acts);
  b.tabIndex = 0; b.setAttribute("role", "button");
  b.setAttribute("aria-label", `${t.title || tbDomain(t.url)}: switch to this tab`);
  x.setAttribute("aria-label", "Close this tab"); pin.setAttribute("aria-label", pin.title);
  for (const btn of [x, pin]) btn.addEventListener("keydown", e => e.stopPropagation());
  b.onclick = () => focusTab(t);
  b.onkeydown = e => {
    if (e.target !== b) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focusTab(t); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); pop(t, b); }
  };
  return b;
}

async function pop(t, el) {
  el.classList.add("popping");
  await chrome.tabs.remove(t.id).catch(() => {});
  setTimeout(load, 180);
}

async function focusTab(t) {
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
}

function openMark(t) {
  marking = t;
  $("markTitle").textContent = t.title || tbDomain(t.url);
  $("markNote").value = "";
  $("markBox").hidden = false;
  $("markNote").focus();
}
$("markCancel").onclick = () => { $("markBox").hidden = true; marking = null; };
$("markSave").onclick = async () => {
  if (!marking) return;
  await chrome.runtime.sendMessage({ type: "tb-mark", tabId: marking.id, note: $("markNote").value.trim() });
  $("markBox").hidden = true; marking = null; load();
};
$("markNote").addEventListener("keydown", e => { if (e.key === "Enter") $("markSave").click(); });

$("popIdle").onclick = async () => {
  const targets = state.tabs.filter(t => isIdle(t) && !t.pinned && !t.audible && !t.task);
  if (!targets.length) return;
  if (!confirm(`Close ${targets.length} idle tab${targets.length > 1 ? "s" : ""}? Pinned tabs, tabs playing sound and unfinished tasks stay open.`)) return;
  await chrome.tabs.remove(targets.map(t => t.id)).catch(() => {});
  load();
};

async function saveUi() { await chrome.storage.local.set({ ui: { groupBy: $("groupBy").value, idleOnly: $("idleOnly").checked } }); render(); }
$("groupBy").onchange = saveUi;
$("idleOnly").onchange = saveUi;

async function saveSettings() {
  const settings = {
    idleMinutes: Math.max(1, Number($("idleMinutes").value) || TB_DEFAULTS.idleMinutes),
    taskRemindMinutes: Math.max(1, Number($("taskRemindMinutes").value) || TB_DEFAULTS.taskRemindMinutes),
    notify: $("notify").checked
  };
  await chrome.storage.local.set({ settings });
  state.settings = settings; render();
}
["idleMinutes", "taskRemindMinutes", "notify"].forEach(id => $(id).onchange = saveSettings);

function btn(label, fn) { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; return b; }

// The side panel stays open, so keep it current: refresh on tab changes and every 30 s.
// A refresh waits while the pointer is on a bubble or the note box is open, so nothing moves under the cursor.
let refreshTimer = null;
function busy() { return !$("markBox").hidden || document.querySelector(".bubble:hover, .bubble:focus-within"); }
function scheduleRefresh(delay = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => (busy() ? scheduleRefresh(800) : load()), delay);
}
for (const ev of ["onCreated", "onRemoved", "onActivated", "onUpdated", "onMoved", "onAttached", "onDetached"]) {
  chrome.tabs[ev].addListener((id, info) => {
    if (ev === "onUpdated" && !(info && (info.title || info.status === "complete" || info.favIconUrl))) return;
    scheduleRefresh();
  });
}
chrome.storage.onChanged.addListener(() => scheduleRefresh(400));
setInterval(() => scheduleRefresh(0), 30000);

load();
