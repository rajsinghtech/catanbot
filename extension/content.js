const BRIDGE = "http://127.0.0.1:8765";

const post = (path, body) => {
  if (globalThis.chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ source: "catanbot-bridge", path, body }).catch(() => {});
    return;
  }
  fetch(`${BRIDGE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
};

post("/api/ping", { href: location.href, t: Date.now() });

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data;
  if (!msg || !["catanbot", "catanbot-app-state"].includes(msg.source)) return;
  post(msg.path, msg.body);
});

const seen = new Set();
const scrape = () => {
  const nodes = document.querySelectorAll(
    "[class*='scrollItemContainer'], [class*='messagePart'], [class*='virtualScroller'] > *",
  );
  for (const n of nodes) {
    const text = n.innerText?.trim();
    if (!text) continue;
    const idx = n.getAttribute("data-index") ?? n.dataset?.index;
    const key = `${idx != null && idx !== "" ? `i:${idx}` : Math.round(n.getBoundingClientRect().top)}|${text}|${[...n.querySelectorAll("img")].map((i) => i.alt).join(",")}`;
    if (seen.has(key)) continue;
    if (
      !/(rolled|built|placed|got|stole|moved Robber|discarded|gave |wants to give|Friendly Robber|bought a development|played|received starting)/i.test(
        text,
      )
    ) {
      continue;
    }
    seen.add(key);
    if (seen.size > 400) {
      const first = seen.values().next().value;
      seen.delete(first);
    }
    const icons = [...n.querySelectorAll("img")].map((i) => i.alt).filter(Boolean);
    post("/api/log", { text, icons, href: location.href, eventKey: key });
  }
};

const obs = new MutationObserver(scrape);
const boot = () => {
  if (!document.body) return;
  obs.observe(document.body, { childList: true, subtree: true });
  scrape();
};
if (document.body) boot();
else document.addEventListener("DOMContentLoaded", boot);
