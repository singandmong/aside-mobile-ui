import { describe, expect, test } from "bun:test";
import { parseDomProjection, parseHostList, parseResult, validateBrowserAction } from "../src/aside-bridge";

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
