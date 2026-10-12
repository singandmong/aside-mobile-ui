import { expect, test } from "bun:test";
import { createApp, type EnvironmentBackend } from "../src/server";

const MAC = { id: "h1", label: "Mac mini", platform: "macos", online: true, connection: "direct" as const, capabilities: { sessions: true, prompts: true, stop: true, browserTabs: true, domProjection: true, screenshot: true, browserActions: true } };

function backendStub(overrides: Partial<EnvironmentBackend> = {}): EnvironmentBackend {
  return {
    environments: async () => [MAC],
    tabs: async () => [],
    sessions: async () => [],
    messages: async () => [],
    screenshot: async () => ({ mime: "image/png", data: "x" }),
    dom: async () => ({ title: "T", url: "https://example.com", text: "", blocks: [], links: [], inputs: [] }),
    action: async () => ({ ok: true }),
    exec: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    ...overrides,
  };
}

const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers });
const post = (path: string, body?: unknown) => new Request(`http://localhost${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

test("bearer token gates environment listing", async () => {
  const app = createApp({ token: "secret", trustTailscaleIdentity: false, trustedUsers: [], backend: backendStub() });
  expect((await app(get("/api/health"))).status).toBe(200);
  expect((await app(get("/api/environments"))).status).toBe(401);
  const response = await app(get("/api/environments", { authorization: "Bearer secret" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([MAC]);
});

test("Tailscale identity is accepted only when enabled and allowed", async () => {
  const open = createApp({ token: "", trustTailscaleIdentity: true, trustedUsers: [], backend: backendStub() });
  expect((await open(get("/api/environments", { "Tailscale-User-Login": "anyone@example.com" }))).status).toBe(200);
  expect((await open(get("/api/environments"))).status).toBe(401);

  const allow = createApp({ token: "", trustTailscaleIdentity: true, trustedUsers: ["owner@example.com"], backend: backendStub() });
  expect((await allow(get("/api/environments", { "Tailscale-User-Login": "Owner@Example.com" }))).status).toBe(200);
  expect((await allow(get("/api/environments", { "Tailscale-User-Login": "guest@example.com" }))).status).toBe(401);

  const disabled = createApp({ token: "t", trustTailscaleIdentity: false, trustedUsers: [], backend: backendStub() });
  expect((await disabled(get("/api/environments", { "Tailscale-User-Login": "owner@example.com" }))).status).toBe(401);
});

test("routes session operations to the selected environment", async () => {
  const calls: string[] = [];
  const app = createApp({ token: "", trustTailscaleIdentity: false, trustedUsers: [], backend: backendStub({
    exec: async (env, prompt) => { calls.push(`exec:${env}:${prompt}`); return { ok: true }; },
    resume: async (env, session, prompt) => { calls.push(`resume:${env}:${session}:${prompt}`); return { ok: true }; },
    stop: async (env, session) => { calls.push(`stop:${env}:${session}`); return { ok: true }; },
    messages: async (env, session) => { calls.push(`messages:${env}:${session}`); return []; },
  }) });
  expect((await app(post("/api/environments/h1/exec", { prompt: "hello" }))).status).toBe(200);
  expect((await app(post("/api/environments/h1/sessions/s1/resume", { prompt: "again" }))).status).toBe(200);
  expect((await app(post("/api/environments/h1/sessions/s1/stop"))).status).toBe(200);
  expect((await app(get("/api/environments/c%3Ah2/sessions/s2/messages"))).status).toBe(200);
  expect(calls).toEqual(["exec:h1:hello", "resume:h1:s1:again", "stop:h1:s1", "messages:c:h2:s2"]);
});

test("rejects invalid input before reaching the backend", async () => {
  let called = false;
  const app = createApp({ token: "", trustTailscaleIdentity: false, trustedUsers: [], backend: backendStub({
    action: async () => { called = true; return { ok: true }; },
    exec: async () => { called = true; return { ok: true }; },
  }) });
  expect((await app(post("/api/environments/h1/tabs/t/action", { action: "click", x: -1, y: 2 }))).status).toBe(400);
  expect((await app(post("/api/environments/h1/exec", { prompt: "" }))).status).toBe(400);
  expect(called).toBe(false);
});

test("maps offline environments to 503", async () => {
  const app = createApp({ token: "", trustTailscaleIdentity: false, trustedUsers: [], backend: backendStub({ sessions: async () => { throw new Error("environment_offline"); } }) });
  const response = await app(get("/api/environments/h1/sessions"));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "environment_offline" });
});
