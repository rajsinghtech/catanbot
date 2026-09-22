const BRIDGE = "http://127.0.0.1:8765";
const $ = (id) => document.getElementById(id);

async function bridge(path, body, method = "GET") {
  const init = { method, headers: { "content-type": "application/json" } };
  if (method !== "GET") init.body = JSON.stringify(body ?? {});
  const response = await fetch(`${BRIDGE}${path}`, init);
  const text = await response.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* keep the diagnostic */ }
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return data;
}

function modeText(play) {
  if (play?.mode === "auto-bots") return "AUTO-PLAY ON · bot match";
  if (play?.mode === "paused-bots") return "AUTO OFF · bot match selected";
  if (play?.mode === "armed-match") return "ARMED · attached match (clicks gated)";
  return "RECOMMENDATION-ONLY · no clicks";
}

async function refresh() {
  try {
    const state = await bridge("/api/health");
    $("state").textContent = modeText(state.play);
    $("state").className = state.play?.on ? "ok" : "";
    $("match").textContent = state.colonistBoard
      ? `${state.players} players · ${state.phase} · menu: ${state.app?.actionLabel || "not observed"}`
      : state.live ? "Colonist tab attached; waiting for the authoritative board." : "No live Colonist board yet.";
  } catch (error) {
    $("state").textContent = "Bridge offline";
    $("state").className = "warn";
    $("match").textContent = String(error);
  }
}

async function activeColonistTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && /colonist\.io/i.test(active.url || "")) return active;
  const tabs = await chrome.tabs.query({ url: ["*://colonist.io/*", "*://www.colonist.io/*"] });
  return tabs.find((tab) => tab.id) || null;
}

async function attach() {
  const tab = await activeColonistTab();
  if (!tab?.id) throw new Error("Open a colonist.io game tab first.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["attach.js"] });
  await bridge("/api/ping", { href: tab.url || "popup", tabId: tab.id }, "POST");
  $("out").textContent = `Attached ${tab.url}.`;
  await refresh();
}

async function setMode(autoMode) {
  const state = await bridge("/api/settings", { autoMode }, "POST");
  $("out").textContent = modeText(state.play);
  await refresh();
}

async function setHud(visible) {
  const tab = await activeColonistTab();
  if (!tab?.id) throw new Error("Open a colonist.io game tab first.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["attach.js"] });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (next) => {
      if (typeof window.__catanbotSetHudVisible === "function") window.__catanbotSetHudVisible(next);
    },
    args: [visible],
  });
  $("out").textContent = visible ? "HUD shown in the active game." : "HUD hidden in the active game.";
}

async function safe(fn) {
  try { await fn(); }
  catch (error) { $("out").textContent = String(error); }
}

$("attach").onclick = () => safe(attach);
$("recommend").onclick = () => safe(() => setMode("recommendation"));
$("bots").onclick = () => safe(() => setMode("bots"));
$("off").onclick = () => safe(() => setMode("off"));
$("showHud").onclick = () => safe(() => setHud(true));
$("hideHud").onclick = () => safe(() => setHud(false));
$("open").onclick = () => chrome.tabs.create({ url: `${BRIDGE}/` });

refresh();
setInterval(refresh, 1500);
