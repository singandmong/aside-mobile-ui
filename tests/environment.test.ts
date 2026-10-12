import { expect, test } from "bun:test";
import { toEnvironment, normalizeMessages } from "../src/environment";

test("online remote-control host exposes every capability", () => {
  const env = toEnvironment({ id: "h1", deviceName: "Mac mini", platform: "macos", online: true, remoteControlEnabled: true }, "local");
  expect(env).toMatchObject({ id: "h1", label: "Mac mini", platform: "macos", online: true, connection: "local" });
  expect(Object.values(env.capabilities).every(Boolean)).toBe(true);
});

test("offline or disabled host exposes no capability", () => {
  const offline = toEnvironment({ id: "h2", deviceName: "MacBook", platform: "macos", online: false, remoteControlEnabled: true }, "aside-remote");
  const disabled = toEnvironment({ id: "h3", deviceName: "PC", platform: "windows", online: true, remoteControlEnabled: false }, "relay");
  expect(Object.values(offline.capabilities).some(Boolean)).toBe(false);
  expect(Object.values(disabled.capabilities).some(Boolean)).toBe(false);
});

test("normalizes Aside messages to role and text", () => {
  expect(normalizeMessages([
    { role: "user", content: "hello", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", name: "x" }, { type: "text", text: "b" }] },
    { role: "toolResult", content: "hidden" },
    "garbage",
  ])).toEqual([
    { role: "user", text: "hello", timestamp: 1 },
    { role: "assistant", text: "a\nb", timestamp: null },
  ]);
});
