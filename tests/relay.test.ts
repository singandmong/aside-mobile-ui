import { afterEach, expect, test } from "bun:test";
import { handleRequest } from "../src/connector";
import type { EnvironmentSummary } from "../src/environment";
import { validateParams } from "../src/protocol";
import { HubBackend, RelayHub } from "../src/relay";
import { createApp, type EnvironmentBackend } from "../src/server";

const CAPS = { sessions: true, prompts: true, stop: true, browserTabs: true, domProjection: true, screenshot: true, browserActions: true };
const env = (id: string, label: string, connection: EnvironmentSummary["connection"]): EnvironmentSummary => ({ id, label, platform: "macos", online: true, connection, capabilities: CAPS });

function backendStub(overrides: Partial<EnvironmentBackend> = {}): EnvironmentBackend {
  const none = async () => [];
  return { environments: none, tabs: none, sessions: none, messages: none, screenshot: none, dom: none, action: none, exec: none, resume: none, stop: none, ...overrides };
}

/** Waits for a condition driven by socket events, yielding to the event loop instead of guessing a duration. */
async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2_000 && !check(); turn++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

test("pairing codes are single use and expire", () => {
  let now = 1_000_000;
  const hub = new RelayHub(null, () => now);
  const first = hub.startPairing();
  expect(first.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(hub.consumePairing(first.code.toLowerCase(), "Mini")).not.toBeNull();
  expect(hub.consumePairing(first.code, "Mini")).toBeNull();
  const second = hub.startPairing();
  now += 10 * 60_000 + 1;
  expect(hub.consumePairing(second.code, "Mini")).toBeNull();
});

test("connector secrets authenticate only their own connector", () => {
  const hub = new RelayHub(null);
  const paired = hub.consumePairing(hub.startPairing().code, "Mini")!;
  expect(hub.authenticate(`Bearer ${paired.connectorId}.${paired.secret}`)).toBe(paired.connectorId);
  expect(hub.authenticate(`Bearer ${paired.connectorId}.${paired.secret}x`)).toBeNull();
  expect(hub.authenticate(`Bearer 000000000000.${paired.secret}`)).toBeNull();
  expect(hub.authenticate(null)).toBeNull();
});

test("connector rejects requests that try to widen its scope", async () => {
  expect(() => validateParams("shell", [])).toThrow();
  expect(() => validateParams("sessions", ["other-host"])).toThrow();
  expect(() => validateParams("messages", ["../x"])).toThrow();
  expect(() => validateParams("action", ["t", { action: "eval", code: "x" }])).toThrow();
  const called: string[] = [];
  const backend = backendStub({ stop: async (host, session) => { called.push(`${host}:${session}`); return { ok: true }; } });
  expect(await handleRequest(backend, "local-host", { type: "request", id: "1", method: "stop", params: ["bad id!"] })).toEqual({ type: "response", id: "1", ok: false, error: "bad_request" });
  expect(await handleRequest(backend, "local-host", { type: "request", id: "2", method: "stop", params: ["s1"] })).toMatchObject({ ok: true });
  expect(await handleRequest(backend, null, { type: "request", id: "3", method: "stop", params: ["s1"] })).toMatchObject({ ok: false, error: "environment_offline" });
  expect(called).toEqual(["local-host:s1"]);
});

let server: ReturnType<typeof Bun.serve> | null = null;
let socket: WebSocket | null = null;
afterEach(() => { socket?.close(); server?.stop(true); socket = null; server = null; });

test("phone requests reach a paired connector end to end, and fail cleanly when it disconnects", async () => {
  const hub = new RelayHub(null);
  const local = backendStub({ environments: async () => [env("mini-host", "Mac mini (via Aside cloud)", "aside-remote"), env("book-host", "MacBook", "local")] });
  const fetch = createApp({ token: "phone", trustTailscaleIdentity: false, trustedUsers: [], backend: new HubBackend(local, hub), relay: hub });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch, websocket: hub.websocket });
  const base = `http://127.0.0.1:${server.port}`;
  const phone = { authorization: "Bearer phone" };

  expect((await globalThis.fetch(`${base}/api/pairing`, { method: "POST" })).status).toBe(401);
  const { code } = await (await globalThis.fetch(`${base}/api/pairing`, { method: "POST", headers: phone })).json();
  const pairing = await globalThis.fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code, label: "Mac mini" }) });
  expect(pairing.status).toBe(200);
  const { connectorId, secret } = await pairing.json();
  expect((await globalThis.fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code, label: "again" }) })).status).toBe(403);

  // A real connector: local Aside stub that only knows its own host.
  const seen: string[] = [];
  const connectorBackend = backendStub({ sessions: async (host) => { seen.push(host); return [{ id: "s1", title: "from mini" }]; } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/connect`, { headers: { authorization: `Bearer ${connectorId}.${secret}` } });
  socket = ws;
  ws.addEventListener("message", async (event) => ws.send(JSON.stringify(await handleRequest(connectorBackend, "mini-host", JSON.parse(String(event.data))))));
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(JSON.stringify({ type: "hello", environment: env("mini-host", "Studio.local", "local") }));
  await until(() => hub.list()[0]?.environment !== null);

  const environments: EnvironmentSummary[] = await (await globalThis.fetch(`${base}/api/environments`, { headers: phone })).json();
  expect(environments.map((item) => [item.id, item.connection, item.label])).toEqual([
    ["book-host", "local", "MacBook"],
    [`relay~${connectorId}`, "relay", "Mac mini"],
  ]);

  const sessions = await globalThis.fetch(`${base}/api/environments/relay~${connectorId}/sessions`, { headers: phone });
  expect(await sessions.json()).toEqual([{ id: "s1", title: "from mini" }]);
  expect(seen).toEqual(["mini-host"]);

  const bad = await globalThis.fetch(`${base}/connect`, { headers: { authorization: `Bearer ${connectorId}.wrong-secret-wrong-secret` } });
  expect(bad.status).toBe(401);

  ws.close();
  await until(() => hub.list()[0]?.online === false);
  const offline = await globalThis.fetch(`${base}/api/environments/relay~${connectorId}/sessions`, { headers: phone });
  expect(offline.status).toBe(503);
  const after: EnvironmentSummary[] = await (await globalThis.fetch(`${base}/api/environments`, { headers: phone })).json();
  expect(after.find((item) => item.id === `relay~${connectorId}`)?.online).toBe(false);
  expect(after.some((item) => item.id === "mini-host")).toBe(true);

  expect((await globalThis.fetch(`${base}/api/connectors/${connectorId}`, { method: "DELETE", headers: phone })).status).toBe(200);
  expect(hub.authenticate(`Bearer ${connectorId}.${secret}`)).toBeNull();
});
