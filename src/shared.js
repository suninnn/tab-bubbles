// Shared settings and helpers (loaded by the side panel; background imports via importScripts).
const TB_DEFAULTS = {
  idleMinutes: 60,          // a tab not looked at for this long counts as "idle"
  taskRemindMinutes: 15,    // remind about an unfinished task after this long away from it
  notify: true              // show a system notification (badge is always on)
};

async function tbSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...TB_DEFAULTS, ...(settings || {}) };
}

// "5 min ago", "2 h 3 min ago", "just now"
function tbAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  return tbDur(ms) + " ago";
}
function tbDur(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1 min";
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " h " + (m % 60) + " min";
  const d = Math.floor(h / 24);
  return d + " d " + (h % 24) + " h";
}

function tbDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, "") || url; } catch { return url || ""; }
}
