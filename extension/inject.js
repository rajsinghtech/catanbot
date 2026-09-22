(() => {
  if (window.__catanbotWsHook) return;
  window.__catanbotWsHook = true;

  const PING = [0x82, 0xa2, 0x69, 0x64, 0xa3, 0x31, 0x33, 0x36];
  const sendBytes = (bytes) => {
    if (!bytes || bytes.length < 12) return;
    let ping = bytes.length <= 40;
    if (ping) {
      for (let i = 0; i < PING.length; i++) if (bytes[i] !== PING[i]) ping = false;
    }
    if (ping) return;
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    window.postMessage({ source: "catanbot", path: "/api/ws", body: { b64: btoa(bin), href: location.href } }, "*");
  };

  const Native = window.WebSocket;
  function Patched(url, protocols) {
    const ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) sendBytes(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) {
        sendBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        data.arrayBuffer().then((buf) => sendBytes(new Uint8Array(buf))).catch(() => {});
      }
    });
    return ws;
  }
  Patched.prototype = Native.prototype;
  Patched.CONNECTING = Native.CONNECTING;
  Patched.OPEN = Native.OPEN;
  Patched.CLOSING = Native.CLOSING;
  Patched.CLOSED = Native.CLOSED;
  window.WebSocket = Patched;

  // The extension has a MAIN-world view of Colonist's store, so it can expose
  // the same small action/menu projection as the CDP driver. This keeps
  // recommendation-only mode useful in human, private, and ranked matches;
  // the extension still never actuates a click.
  let lastAppKey = "";
  let sentTopology = false;
  const postAppState = (body) => window.postMessage({ source: "catanbot-app-state", path: "/api/app-state", body }, "*");
  const appState = () => {
    const chunks = window.webpackChunkkatan;
    if (!chunks) return null;
    let req = window.__catanbotWebpackRequire;
    if (typeof req !== "function") {
      chunks.push([[Date.now()], {}, (runtime) => { req = runtime; }]);
      if (typeof req === "function") window.__catanbotWebpackRequire = req;
    }
    if (typeof req !== "function") return null;
    const manager = req(47570)?.IH;
    const tileState = manager?.gameState?.mapState?.tileState;
    if (!manager?.gameController || !tileState) return null;
    const devPlayers = manager.gameController?.stateController?.state
      ?.mechanicDevelopmentCardsState?.players || {};
    const store = manager.gameStore?.getState?.();
    const tradeState = store?.gameState?.tradeState;
    const endGamePlayers = store?.gameEnd?.providerProps?.gameEndData?.endGameState?.players || {};
    const winnerEntry = Object.values(endGamePlayers).find((entry) => entry?.winningPlayer);
    const winnerColor = Number.isFinite(winnerEntry?.color) ? winnerEntry.color : null;
    const robberIndex = store?.gameState?.mechanicRobberState?.locationTileIndex;
    const robberTile = Number.isInteger(robberIndex) ? tileState.tiles?.[robberIndex]?.hexFace : null;
    const mapState = !sentTopology ? {
      tileHexStates: tileState.tileHexStates,
      tileCornerStates: tileState.tileCornerStates,
      tileEdgeStates: tileState.tileEdgeStates,
      portEdgeStates: manager.gameState.mapState?.portState?.portEdgeStates || {},
    } : undefined;
    return {
      myColor: manager.gameController.myColor,
      currentState: manager.gameController.currentState,
      diceState: manager.gameController.diceState,
      isGameOver: manager.gameState?.isGameOver,
      winnerColor,
      robber: robberTile ? { q: robberTile.x, r: robberTile.y } : null,
      players: (manager.gameState?.players || []).map((player) => ({
        color: player.state?.color,
        username: player.userState?.username,
        isBot: player.userState?.isBot,
        cards: player.state?.resourceCards?.cards || player.resourceCards?.state?.cards || [],
        devCards: devPlayers[String(player.state?.color)]?.developmentCards?.cards || [],
        devCardsUsed: devPlayers[String(player.state?.color)]?.developmentCardsUsed || [],
        victoryPointsState: player.state?.victoryPointsState || {},
      })),
      tradeOffers: Object.entries(tradeState?.activeOffers || {}).flatMap(([id, offer]) => offer ? [{
        id,
        creator: offer.creator,
        offeredResources: offer.offeredResources || [],
        wantedResources: offer.wantedResources || [],
        playerResponses: offer.playerResponses || {},
      }] : []),
      ...(mapState ? { mapState } : {}),
    };
  };
  const pollAppState = () => {
    try {
      const state = appState();
      if (!state) return;
      const key = JSON.stringify({
        myColor: state.myColor,
        currentState: state.currentState,
        diceState: state.diceState,
        isGameOver: state.isGameOver,
        winnerColor: state.winnerColor,
        robber: state.robber,
        players: state.players,
        tradeOffers: state.tradeOffers,
      });
      if (key === lastAppKey && sentTopology) return;
      lastAppKey = key;
      postAppState(state);
      if (state.mapState) sentTopology = true;
    } catch {
      /* Colonist can tear down webpack state during navigation. */
    }
  };
  pollAppState();
  setInterval(pollAppState, 350);
})();
