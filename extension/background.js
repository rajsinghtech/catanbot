const BRIDGE = "http://127.0.0.1:8765";

async function bridgeRequest(path, body, method = "POST") {
  const init = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (method !== "GET") init.body = JSON.stringify(body ?? {});
  const response = await fetch(`${BRIDGE}${path}`, {
    ...init,
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* Keep a non-JSON diagnostic response as text. */
  }
  return { ok: response.ok, status: response.status, data };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "catanbot-bridge") return undefined;
  bridgeRequest(message.path, message.body, message.method || "POST")
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

async function attach(tabId, url) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["attach.js"] });
  } catch {
    /* tab may not be injectable yet */
  }
  bridgeRequest("/api/ping", { href: url || "sw", tabId }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && /colonist\.io/i.test(tab.url || "")) {
    attach(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => {
    if (/colonist\.io/i.test(tab.url || "")) attach(tabId, tab.url);
  }).catch(() => {});
});

chrome.tabs.query({ url: ["*://colonist.io/*", "*://www.colonist.io/*"] }).then((tabs) => {
  for (const tab of tabs) if (tab.id) attach(tab.id, tab.url);
});
