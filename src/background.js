// TabBubbles service worker: tracks when tabs were opened / last viewed,
// keeps the list of unfinished tasks, and shows the badge + reminders.
importScripts("shared.js");

const S = chrome.storage.session; // per-browser-session data (tab ids reset on restart)
const L = chrome.storage.local;   // durable data (settings, manual tasks)

// Clicking the toolbar icon opens TabBubbles in the browser's side panel (right side).
function useSidePanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
useSidePanel();

async function getMeta() { return (await S.get("meta")).meta || {}; }        // tabId -> {openedAt, signals, signalsAt}
async function setMeta(meta) { await S.set({ meta }); }
async function getTasks() { return (await L.get("tasks")).tasks || {}; }     // tabId -> {note, url, title, markedAt, reminded}
async function setTasks(tasks) { await L.set({ tasks }); }

async function ensureKnown() {
  const meta = await getMeta();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const live = new Set();
  for (const t of tabs) {
    live.add(String(t.id));
    if (!meta[t.id]) meta[t.id] = { openedAt: now, openedKnown: false, signals: [] };
  }
  for (const id of Object.keys(meta)) if (!live.has(id)) delete meta[id];
  await setMeta(meta);

  // Re-attach manual tasks to tabs after a browser restart (tab ids change) by URL.
  const tasks = await getTasks();
  let changed = false;
  for (const [id, task] of Object.entries(tasks)) {
    if (live.has(id)) continue;
    const match = tabs.find(t => t.url === task.url && !tasks[t.id]);
    if (match) { tasks[match.id] = task; changed = true; }
    delete tasks[id]; changed = true;
  }
  if (changed) await setTasks(tasks);
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureKnown();
  chrome.alarms.create("tb-tick", { periodInMinutes: 1 });
  tick();
});
chrome.runtime.onStartup.addListener(async () => {
  await ensureKnown();
  chrome.alarms.create("tb-tick", { periodInMinutes: 1 });
});

chrome.tabs.onCreated.addListener(async tab => {
  const meta = await getMeta();
  meta[tab.id] = { openedAt: Date.now(), openedKnown: true, signals: [] };
  await setMeta(meta);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const meta = await getMeta(); delete meta[tabId]; await setMeta(meta);
  const tasks = await getTasks(); if (tasks[tabId]) { delete tasks[tabId]; await setTasks(tasks); }
  chrome.notifications.clear("tb-" + tabId);
  tick();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // Looking at a task tab resets its reminder.
  const tasks = await getTasks();
  if (tasks[tabId]) { tasks[tabId].reminded = false; await setTasks(tasks); }
  const meta = await getMeta();
  if (meta[tabId]) { meta[tabId].reminded = false; await setMeta(meta); }
  chrome.notifications.clear("tb-" + tabId);
  tick();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "tb-signals" && sender.tab) {
      const meta = await getMeta();
      const m = meta[sender.tab.id] || { openedAt: Date.now(), openedKnown: false, signals: [] };
      m.signals = msg.signals || [];
      m.signalsAt = Date.now();
      meta[sender.tab.id] = m;
      await setMeta(meta);
      tick();
    } else if (msg.type === "tb-state") {
      await ensureKnown();
      sendResponse(await buildState());
      return;
    } else if (msg.type === "tb-mark") {
      const tasks = await getTasks();
      const tab = await chrome.tabs.get(msg.tabId);
      tasks[msg.tabId] = { note: msg.note || "", url: tab.url, title: tab.title, markedAt: Date.now(), reminded: false };
      await setTasks(tasks);
      tick();
    } else if (msg.type === "tb-unmark") {
      const tasks = await getTasks(); delete tasks[msg.tabId]; await setTasks(tasks);
      const meta = await getMeta(); if (meta[msg.tabId]) { meta[msg.tabId].dismissed = true; await setMeta(meta); }
      tick();
    }
    sendResponse({ ok: true });
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(a => { if (a.name === "tb-tick") tick(); });

chrome.notifications.onClicked.addListener(async id => {
  if (!id.startsWith("tb-")) return;
  const tabId = Number(id.slice(3));
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
  chrome.notifications.clear(id);
});

// Build the full picture the side panel draws.
async function buildState() {
  const [tabs, meta, tasks, settings] = await Promise.all([chrome.tabs.query({}), getMeta(), getTasks(), tbSettings()]);
  const now = Date.now();
  return {
    now, settings,
    tabs: tabs.map(t => {
      const m = meta[t.id] || {};
      const lastSeen = t.active ? now : (t.lastAccessed || m.openedAt || now);
      const manual = tasks[t.id];
      // A checkout/application page alone is only a hint; it becomes a task with a real signal.
      const sig = m.signals || [];
      const auto = !m.dismissed && sig.some(s => s !== "flow-page") ? sig : null;
      return {
        id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl,
        active: t.active, pinned: t.pinned, audible: t.audible,
        openedAt: m.openedAt, openedKnown: !!m.openedKnown, lastSeen,
        idleMs: now - lastSeen,
        task: manual ? { kind: "manual", note: manual.note, since: manual.markedAt }
            : auto ? { kind: "auto", signals: auto, since: m.signalsAt } : null
      };
    })
  };
}

async function tick() {
  const state = await buildState();
  const { settings, tabs, now } = state;
  const dueMs = settings.taskRemindMinutes * 60000;
  const due = tabs.filter(t => t.task && !t.active && t.idleMs >= dueMs);
  const idle = tabs.filter(t => !t.active && !t.pinned && t.idleMs >= settings.idleMinutes * 60000);

  // Badge: unfinished tasks first (orange), else idle tab count (grey).
  if (due.length) {
    chrome.action.setBadgeBackgroundColor({ color: "#E8590C" });
    chrome.action.setBadgeText({ text: String(due.length) });
  } else if (idle.length) {
    chrome.action.setBadgeBackgroundColor({ color: "#868E96" });
    chrome.action.setBadgeText({ text: String(idle.length) });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
  chrome.action.setTitle({ title: `TabBubbles: ${tabs.length} tabs, ${idle.length} idle, ${due.length} unfinished` });

  if (!settings.notify || !due.length) return;
  // Don't nag while the person is away from the computer.
  const userState = await chrome.idle.queryState(120);
  if (userState !== "active") return;

  const tasks = await getTasks();
  const meta = await getMeta();
  for (const t of due) {
    const store = t.task.kind === "manual" ? tasks[t.id] : meta[t.id];
    if (!store || store.reminded) continue;
    store.reminded = true;
    const what = t.task.kind === "manual" && t.task.note ? t.task.note : describe(t.task.signals);
    chrome.notifications.create("tb-" + t.id, {
      type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Unfinished: " + (t.title || tbDomain(t.url)).slice(0, 60),
      message: `${what}. You left it ${tbAgo(t.idleMs)}` + (t.openedAt ? `, opened ${tbAgo(now - t.openedAt)}.` : "."),
      priority: 1
    });
  }
  await setTasks(tasks);
  await setMeta(meta);
}

function describe(signals = []) {
  if (signals.includes("otp")) return "A verification code is waiting";
  if (signals.includes("half-form")) return "A form is half filled in";
  if (signals.includes("unsaved-text")) return "You typed text that isn't sent yet";
  if (signals.includes("flow-page")) return "A checkout / application page is open";
  return "Something here looks unfinished";
}
