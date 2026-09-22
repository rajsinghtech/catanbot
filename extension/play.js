// Intentionally inert.  Auto-play has one actuator: src/play/drive.ts via
// trusted Chrome DevTools Protocol mouse events.  Keep this file as a safety
// guard for stale extension builds that still try to load it.
(() => {
  if (window.__catanbotPlayDisabled) return;
  window.__catanbotPlayDisabled = true;
})();
