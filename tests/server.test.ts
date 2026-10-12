import { describe, expect, test } from "bun:test";
import type { AsideBridgeLike } from "../src/server";
import { createApp } from "../src/server";

function bridgeStub(overrides: Partial<AsideBridgeLike> = {}): AsideBridgeLike {
  return {
    hosts: async () => [],
    tabs: async () => [],
    sessions: async () => [],
    messages: async () => [],
    screenshot: async () => ({ mime: "image/png", data: "x" }),
    dom: async () => ({ title: "Test", url: "https://example.com", text: "Test", blocks: [], links: [], inputs: [] }),
    action: async () => ({ ok: true }),
    exec: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    ...overrides,
  };
}

test("health and host routes expose the bridge contract", async () => {
  const app = createApp({
    token: "secret",
    bridge: bridgeStub({
      hosts: async () => [{ id: "h1", deviceName: "Mac", platform: "macos", online: true, remoteControlEnabled: true }],
    }),
  });
  expect((await app(new Request("http://localhost/api/health"))).status).toBe(200);
  expect((await app(new Request("http://localhost/api/hosts"))).status).toBe(401);
  const response = await app(new Request("http://localhost/api/hosts", { headers: { authorization: "Bearer secret" } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toHaveLength(1);
});

test("rejects invalid browser action before bridge invocation", async () => {
  let called = false;
  const app = createApp({ token: "", bridge: bridgeStub({ action: async () => { called = true; return { ok: true }; } }) });
  const response = await app(new Request("http://localhost/api/hosts/h/tabs/t/action", { method: "POST", body: JSON.stringify({ action: "click", x: -1, y: 2 }), headers: { "content-type": "application/json" } }));
  expect(response.status).toBe(400);
  expect(called).toBe(false);
});

test("starts and controls an Aside session", async () => {
  const calls: string[] = [];
  const app = createApp({ token: "", bridge: bridgeStub({
    exec: async (_hostId, prompt) => { calls.push(`exec:${prompt}`); return { ok: true }; },
    resume: async (_hostId, sessionId, prompt) => { calls.push(`resume:${sessionId}:${prompt}`); return { ok: true }; },
    stop: async (_hostId, sessionId) => { calls.push(`stop:${sessionId}`); return { ok: true }; },
  }) });
  expect((await app(new Request("http://localhost/api/hosts/h/exec", { method: "POST", body: JSON.stringify({ prompt: "hello" }) }))).status).toBe(200);
  expect((await app(new Request("http://localhost/api/hosts/h/sessions/s1/resume", { method: "POST", body: JSON.stringify({ prompt: "again" }) }))).status).toBe(200);
  expect((await app(new Request("http://localhost/api/hosts/h/sessions/s1/stop", { method: "POST" }))).status).toBe(200);
  expect(calls).toEqual(["exec:hello", "resume:s1:again", "stop:s1"]);
});
test("returns an on-demand DOM projection", async () => {
  const app = createApp({ bridge: bridgeStub({ dom: async () => ({ title: "Results", url: "https://example.com", text: "answer", blocks: [], links: [], inputs: [] }) }) });
  const response = await app(new Request("http://localhost/api/hosts/h/tabs/t/dom"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ title: "Results", text: "answer" });
});
test("accepts Tailscale Serve identity when explicitly enabled", async () => {
  const app = createApp({ trustTailscaleIdentity: true, bridge: bridgeStub() });
  const response = await app(new Request("http://localhost/api/hosts", { headers: { "Tailscale-User-Login": "owner@example.com" } }));
  expect(response.status).toBe(200);
});
