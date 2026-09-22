import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { refreshRec, resetGame, startServer, stepDemo } from "./server.ts";

const RUN_DIR = join(process.cwd(), ".run");
const PID_FILE = join(RUN_DIR, "catanbot.pid");

const cmd = process.argv[2] ?? "start";

if (cmd === "status") {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.CATANBOT_PORT ?? 8765}/api/health`);
    console.log(await r.text());
  } catch {
    console.log("down");
    process.exit(1);
  }
  process.exit(0);
}

await mkdir(RUN_DIR, { recursive: true });
const { port, close } = await startServer();
await writeFile(PID_FILE, String(process.pid));
await refreshRec();

if (cmd === "demo") {
  const n = Number(process.argv[3] ?? 2);
  resetGame(Number.isFinite(n) ? n : 2);
  await fetch(`http://127.0.0.1:${port}/api/demo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on: true }),
  });
  console.log(`demo ${n}p — HUD http://127.0.0.1:${port}`);
}

if (cmd === "attach") {
  console.log("Open colonist.io in Chrome. Load extension/ or inject public/inject.js");
  console.log(`HUD http://127.0.0.1:${port}`);
}

const stop = () => {
  close();
  if (existsSync(PID_FILE)) unlink(PID_FILE).catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (cmd === "once") {
  await stepDemo();
  const health = await readFile(PID_FILE, "utf8").catch(() => "");
  console.log("pid", health.trim());
  stop();
}
