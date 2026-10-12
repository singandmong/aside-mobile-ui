import { describe, expect, test } from "bun:test";
import { isLocalHost, parseCreatedSession, parseDomProjection, parseHostList, parseResult, parseSessionList, validateBrowserAction } from "../src/aside-bridge";

describe("Aside bridge input boundaries", () => {
  test("keeps only safe host fields", () => {
    expect(parseHostList(JSON.stringify({ hosts: [{ id: "h1", deviceName: "Mac", platform: "macos", online: true, remoteControlEnabled: true, secret: "no" }] }))).toEqual([
      { id: "h1", deviceName: "Mac", platform: "macos", online: true, remoteControlEnabled: true },
    ]);
  });

  test("extracts the structured result marker", () => {
    expect(parseResult('noise\n__ASIDE_MOBILE_RESULT__{"ok":true}\n')).toEqual({ ok: true });
  });

  test("rejects unknown actions and invalid coordinates", () => {
    expect(() => validateBrowserAction({ action: "run", x: 1, y: 1 })).toThrow();
    expect(() => validateBrowserAction({ action: "click", x: -1, y: 1 })).toThrow();
    expect(validateBrowserAction({ action: "scroll", dx: 0, dy: 600 })).toEqual({ action: "scroll", dx: 0, dy: 600 });
  });

  test("bounds text input", () => {
    expect(() => validateBrowserAction({ action: "type", text: "x".repeat(5001) })).toThrow();
  });
});

describe("DOM projection", () => {
  test("keeps readable page structure and drops executable content", () => {
    const projection = parseDomProjection(JSON.stringify({
      title: "Results", url: "https://example.com", text: "answer", html: "<script>alert(1)</script>",
      blocks: [{ tag: "h1", text: "Results" }], links: [{ text: "Open", href: "/open" }], inputs: [{ type: "search", placeholder: "Search" }],
    }));
    expect(projection).toEqual({
      title: "Results", url: "https://example.com", text: "answer",
      blocks: [{ tag: "h1", text: "Results" }], links: [{ text: "Open", href: "/open" }], inputs: [{ type: "search", placeholder: "Search" }],
    });
    expect("html" in projection).toBe(false);
  });
});

describe("CLI session parsing", () => {
  test("parses session list rows newest first, keeping multi-word titles", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaa  idle  persistent  Weekly  report   draft  2026-10-01T01:00:00.000Z",
      "bbbbbbbbbbbbbbbb  running  ephemeral  Mobile task  2026-10-12T06:00:00.000Z",
      "not a session row",
    ].join("\n");
    expect(parseSessionList(stdout)).toEqual([
      { id: "bbbbbbbbbbbbbbbb", status: "running", kind: "ephemeral", title: "Mobile task", updatedAt: "2026-10-12T06:00:00.000Z" },
      { id: "aaaaaaaaaaaaaaaa", status: "idle", kind: "persistent", title: "Weekly report draft", updatedAt: "2026-10-01T01:00:00.000Z" },
    ]);
  });

  test("extracts the created session id from exec output with ANSI codes", () => {
    expect(parseCreatedSession("\u001b[2mcreated new session: o9bWehZwiNcAf8ru\u001b[0m\n")).toBe("o9bWehZwiNcAf8ru");
    expect(parseCreatedSession("nothing here")).toBeNull();
  });
});

test("detects the Aside host that is this machine", () => {
  const host = { id: "h1", deviceName: "Studio-Mac.local", platform: "macos", online: true, remoteControlEnabled: true };
  expect(isLocalHost(host, "studio-mac.local")).toBe(true);
  expect(isLocalHost(host, "Studio-Mac")).toBe(true);
  expect(isLocalHost(host, "other-mac.local")).toBe(false);
  expect(isLocalHost(host, "x", "h1")).toBe(true);
});
