(() => {
  if (window.__catanbotHudInstalled) return;
  window.__catanbotHudInstalled = true;

  let latest = null;
  let lastPush = 0;
  if (typeof window.__catanbotHudVisible !== "boolean") {
    window.__catanbotHudVisible = false;
  }

  const isVisible = () => window.__catanbotHudVisible === true;
  const applyVisibility = (el) => {
    if (!el) return;
    el.style.display = isVisible() ? "block" : "none";
    el.setAttribute("aria-hidden", String(!isVisible()));
  };

  const ensure = () => {
    let el = document.getElementById("catanbot-overlay");
    if (el) {
      applyVisibility(el);
      return el;
    }
    el = document.createElement("div");
    el.id = "catanbot-overlay";
    el.style.cssText =
      "display:none;position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:380px;padding:14px 16px;background:#f3e2c4;color:#17110b;font:16px/1.3 Georgia,serif;box-shadow:0 12px 32px rgba(0,0,0,.35);pointer-events:none;white-space:pre-wrap";
    (document.body || document.documentElement)?.appendChild(el);
    applyVisibility(el);
    return el;
  };

  const render = (el, state) => {
    if (!state) {
      el.textContent = "Catanbot HUD waiting for live state";
      return;
    }
    const rec = state.rec;
    const game = state.game || {};
    const pending = state.play?.pending || state.pending;
    const lines = [];
    if (!state.colonistBoard) lines.push("NOT YOUR BOARD — waiting for authoritative Colonist state.");
    if (state.play) lines.push(`auto: ${state.play.mode} (${state.play.owner})`);
    if (rec?.action?.label) lines.push(rec.action.label);
    if (rec?.reason) lines.push(rec.reason);
    lines.push(`phase: ${game.phase || "unknown"}  current: ${game.current || "?"}`);
    if (state.app?.actionLabel) lines.push(`menu: ${state.app.actionLabel}`);
    if (pending?.actionId) lines.push(`pending: ${pending.actionId}`);
    if (game.winner) lines.push(`winner: ${game.winner}`);
    el.textContent = lines.join("\n");
    applyVisibility(el);
  };

  const setVisible = (next) => {
    window.__catanbotHudVisible = Boolean(next);
    applyVisibility(document.getElementById("catanbot-overlay"));
  };
  const toggle = () => setVisible(!isVisible());
  window.__catanbotSetHudVisible = setVisible;
  window.__catanbotToggleHud = toggle;

  if (!window.__catanbotHudKeyHandler) {
    window.__catanbotHudKeyHandler = (event) => {
      if (event.altKey && event.shiftKey && event.code === "KeyC") {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }
    };
    window.addEventListener("keydown", window.__catanbotHudKeyHandler, true);
  }

  window.__catanbotSetHudState = (state) => {
    latest = state;
    lastPush = Date.now();
    render(ensure(), state);
  };

  const tick = () => {
    const el = ensure();
    if (latest && Date.now() - lastPush < 4000) render(el, latest);
    else if (!latest) render(el, null);
  };
  tick();
  setInterval(tick, 1200);
})();
