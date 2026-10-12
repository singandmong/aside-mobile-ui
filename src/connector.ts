import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { AsideBridge, type BrowserAction } from "./aside-bridge";
import type { EnvironmentSummary } from "./environment";
import { validateParams, type RelayRequest, type RelayResponse } from "./protocol";
import type { EnvironmentBackend } from "./server";

/** Executes one hub request against this machine's own Aside. The hub never chooses the host. */
export async function handleRequest(backend: EnvironmentBackend, hostId: string | null, request: RelayRequest): Promise<RelayResponse> {
  try {
    const params = validateParams(request.method, request.params);
    if (!hostId) return { type: "response", id: request.id, ok: false, error: "environment_offline" };
    const [a, b] = params as [string, unknown];
    const run: Record<RelayRequest["method"], () => Promise<unknown>> = {
      tabs: () => backend.tabs(hostId),
      sessions: () => backend.sessions(hostId),
      messages: () => backend.messages(hostId, a),
      screenshot: () => backend.screenshot(hostId, a),
      dom: () => backend.dom(hostId, a),
      action: () => backend.action(hostId, a, b as BrowserAction),
      exec: () => backend.exec(hostId, a),
      resume: () => backend.resume(hostId, a, b as string),
      stop: () => backend.stop(hostId, a),
    };
    return { type: "response", id: request.id, ok: true, result: await run[request.method]() };
  } catch (error) {
    const invalid = error instanceof Error && error.message.startsWith("Invalid");
    return { type: "response", id: request.id, ok: false, error: invalid ? "bad_request" : "aside_unavailable" };
  }
}

type ConnectorConfig = { hub: string; connectorId: string; secret: string; label: string };
const CONFIG_PATH = process.env.ASIDE_CONNECTOR_CONFIG ?? join(os.homedir(), ".config", "aside-mobile", "connector.json");

function readConfig(): ConnectorConfig {
  if (!existsSync(CONFIG_PATH)) throw new Error(`Not paired. Run: bun run connector pair --hub <url> --code <code>`);
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function pair(): Promise<void> {
  const hub = arg("hub")?.replace(/\/$/, "");
  const code = arg("code");
  const label = arg("label") ?? os.hostname().replace(/\.local$/, "");
  if (!hub || !code) throw new Error("Usage: bun run connector pair --hub https://<hub> --code XXXX-XXXX [--label Name]");
  const response = await fetch(`${hub}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label }) });
  if (!response.ok) throw new Error(`Pairing failed (${response.status}). The code may be expired or already used.`);
  const { connectorId, secret } = await response.json();
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ hub, connectorId, secret, label } satisfies ConnectorConfig, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
  console.log(`Paired as "${label}". Start with: bun run connector run`);
}

async function run(): Promise<void> {
  const config = readConfig();
  const bridge = new AsideBridge();
  const url = `${config.hub.replace(/^http/, "ws")}/connect`;
  let backoff = 1_000;

  const connect = () => {
    // Bun's client WebSocket accepts request headers; the hub authenticates the upgrade with them.
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${config.connectorId}.${config.secret}` } });
    let environment: EnvironmentSummary | null = null;
    let helloTimer: Timer | undefined;
    const hello = async () => {
      environment = await bridge.localEnvironment().catch(() => null);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "hello", environment }));
    };
    ws.addEventListener("open", () => {
      backoff = 1_000;
      console.log(`connected to ${config.hub}`);
      hello();
      helloTimer = setInterval(hello, 30_000);
    });
    ws.addEventListener("message", async (event) => {
      let request: RelayRequest;
      try { request = JSON.parse(String(event.data)); } catch { return; }
      if (request?.type !== "request" || typeof request.id !== "string") return;
      ws.send(JSON.stringify(await handleRequest(bridge, environment?.id ?? null, request)));
    });
    ws.addEventListener("close", (event) => {
      clearInterval(helloTimer);
      if (event.code === 4001) { console.error("This connector was revoked on the hub. Pair again to reconnect."); process.exit(1); }
      console.log(`disconnected (${event.code}); retrying in ${backoff / 1000}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    });
  };
  connect();
}

if (import.meta.main) {
  const command = process.argv[2];
  (command === "pair" ? pair() : command === "run" ? run() : Promise.reject(new Error("Usage: bun run connector <pair|run>"))).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
