# Standalone Aside Mobile PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide a standalone mobile PWA that uses each user's Tailscale path to inspect and control Aside sessions and browser tabs on their own computers.

**Architecture:** A small Bun server exposes a loopback HTTP interface and invokes the installed Aside CLI. Browser control uses Aside's existing remote REPL primitives (`listBrowserTabs`, `attachBrowserTab`, screenshot, mouse, keyboard); the PWA is a separate static client and does not depend on Herdr, Collie, or herdr-web-ui. Tailscale Serve remains the private ingress; an optional bearer token adds an application-level gate.

**Tech Stack:** Bun, TypeScript, vanilla HTML/CSS/JS PWA, Web Manifest, Service Worker, Bun test.

**Spec:** Approved conversation design: standalone PWA, task/chat plus direct browser control, per-user Tailscale deployment.

## Global Constraints

- MUST NOT import or copy herdr-web-ui code.
- MUST bind to `127.0.0.1` by default.
- MUST NOT expose Aside credentials or SSH keys to the browser.
- MUST NOT persist screenshots, transcripts, or credentials in the PWA cache.
- MUST reject invalid browser coordinates and unknown actions.
- MUST use the installed Aside CLI; no new Aside SDK dependency.

## Review Focus

- Stale browser target IDs: return a clear 404/409, never act on another tab.
- Oversized/invalid input: reject before invoking Aside.
- CLI errors and non-JSON output: return a bounded 502 without leaking command output.
- Optional token: reject missing/wrong token consistently, including static assets.
- Mobile reconnect: client shows disconnected state and does not send actions until refreshed state exists.

---

### Task 1: Bridge contract and validation

**Files:**
- Create: `src/aside-bridge.ts`
- Create: `tests/aside-bridge.test.ts`

**Interfaces:**
- Produces `parseHostList(value)`, `parseResult(stdout)`, `validateBrowserAction(value)` and `AsideBridge` methods for hosts, tabs, sessions, messages, screenshots, and browser actions.

- [ ] Write failing tests for host sanitization, result-marker parsing, coordinate/action validation, and rejection of oversized text.
- [ ] Run `bun test tests/aside-bridge.test.ts` and observe expected missing-module failure.
- [ ] Implement the smallest typed validation and CLI invocation layer using `Bun.spawn` and the `ASIDE_BIN` environment override.
- [ ] Run the focused test and then `bun test`.

### Task 2: Loopback HTTP server

**Files:**
- Create: `src/server.ts`
- Create: `tests/server.test.ts`
- Modify: `package.json`

**Interfaces:**
- `GET /api/hosts`
- `GET /api/hosts/:hostId/tabs`
- `GET /api/hosts/:hostId/sessions`
- `GET /api/hosts/:hostId/sessions/:sessionId/messages`
- `POST /api/hosts/:hostId/tabs/:targetId/screenshot`
- `POST /api/hosts/:hostId/tabs/:targetId/action`

- [ ] Write failing request tests for health, auth, route validation, and bounded error responses.
- [ ] Run focused tests and observe failure.
- [ ] Implement Bun.serve routing, JSON responses, optional `ASIDE_MOBILE_TOKEN`, loopback default, and safe error mapping.
- [ ] Run all tests.

### Task 3: Mobile PWA

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/styles.css`
- Create: `public/manifest.webmanifest`
- Create: `public/sw.js`

**Interfaces:**
- Uses only the HTTP routes from Task 2.
- Shows host/session/tab state; supports refresh, screenshot, click, scroll, text entry, and keyboard key actions.

- [ ] Add static client with no transcript/screenshot persistence and explicit disconnected/error states.
- [ ] Add responsive layout and touch controls.
- [ ] Add service worker that caches only the app shell and never API responses.
- [ ] Verify the app shell and API route with a running server.

### Task 4: Deployment and smoke verification

**Files:**
- Create: `README.md`
- Create: `.env.example`
- Create: `package.json`

- [ ] Document per-user install, `bun run start`, `tailscale serve --bg --https=443 http://127.0.0.1:8787`, and explicit Funnel prohibition.
- [ ] Run unit tests, start the server, query `/api/health`, query real `aside host list --json`, and open the PWA locally.
- [ ] Verify the server remains loopback-only and report Windows as a separate prerequisite until native Windows Aside CLI/remote host registration is available.
