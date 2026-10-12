# Multi-Tailnet Environment UI Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Aside Mobile UI into a session-first control surface where users choose a Mac/PC execution environment before operating Aside, while supporting environments on different Tailscale networks through an optional outbound connector and relay.

**Architecture:** Keep direct Tailscale Serve mode for one tailnet. Add a relay mode in which each host runs an Aside Mobile Connector that makes an outbound authenticated WebSocket connection to a relay; the phone connects only to the relay. The connector owns Aside CLI/REPL access, while the relay routes typed commands and structured events without receiving Aside credentials, browser cookies, or raw provider secrets.

**Tech Stack:** Bun/TypeScript, WebSocket, vanilla TypeScript PWA, SQLite only if durable relay state is required, existing Aside CLI/REPL.

**Spec:** User-approved direction: standalone mobile PWA, structured session output and prompts as the main flow, optional DOM projection/screenshot, Windows deferred.

## Global Constraints

- MUST show execution environments before sessions or browser tabs.
- MUST support direct same-tailnet mode and optional multi-tailnet relay mode.
- MUST NOT transfer Aside credentials, cookies, provider keys, or SSH private keys through the relay.
- MUST use one-time pairing codes and scoped environment identity; no shared static secret in the UI.
- MUST keep browser DOM projection and screenshots on demand only.
- MUST keep the server/connector loopback-bound unless it is the authenticated relay connector.
- MUST show platform and capabilities before enabling controls.
- Windows is deferred from implementation and acceptance testing.

## Review Focus

- Connector disconnect during a prompt: show pending/unknown, never claim delivery.
- Reused or expired pairing code: reject and require a new code.
- Two environments with the same hostname: use immutable environment IDs and user labels.
- Different tailnets: no direct browser-to-host assumption; all relay traffic is authenticated and scoped.
- Stale PWA cache: version app-shell assets and provide visible reconnect state.

---

### Task 1: Environment domain and capability contract

**Files:**
- Create: `src/environment.ts`
- Modify: `src/server.ts`
- Create: `tests/environment.test.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**
- `EnvironmentSummary = { id, label, platform, online, lastSeenAt, authMode, capabilities }`
- `EnvironmentCapabilities = { sessions, prompts, stop, browserTabs, domProjection, screenshot, browserActions }`
- `GET /api/environments`
- `POST /api/environments/:id/select`

- [ ] Write failing tests for stable IDs, platform labels, capability gating, and offline status.
- [ ] Implement a local adapter that maps current Aside host data to environment summaries.
- [ ] Keep existing host routes as internal compatibility routes only; the PWA consumes environment routes.
- [ ] Verify tests and typed bundles.

### Task 2: Session-first information architecture

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `public/ui-state.js` if state logic exceeds the current file

**Interfaces:**
- Screen order: `Environments → Sessions → Session detail → Prompt composer → Optional browser tools`.
- A selected environment is required before session actions are enabled.
- Browser tools stay collapsed and are disabled when the selected environment lacks the capability.

- [ ] Add a mobile environment picker with online/offline state, platform, last seen, and connection method.
- [ ] Add selected-environment header and switch action on every session screen.
- [ ] Move session list and messages above all browser UI.
- [ ] Add explicit pending/sent/failed prompt state and a reconnect banner.
- [ ] Add empty, loading, offline, and authentication states without replacing the page with raw errors.
- [ ] Test the core flow in the browser: choose Mac mini → choose session → read output → enter prompt → return to session list.

### Task 3: Direct same-tailnet adapter

**Files:**
- Modify: `src/aside-bridge.ts`
- Modify: `src/server.ts`
- Modify: `bin/install-launchd.sh`
- Modify: `README.md`
- Modify: `tests/server.test.ts`

**Interfaces:**
- `EnvironmentAdapter.list(): Promise<EnvironmentSummary[]>`
- `EnvironmentAdapter.sessions(environmentId): Promise<SessionSummary[]>`
- `EnvironmentAdapter.sendPrompt(environmentId, input): Promise<DeliveryReceipt>`
- `EnvironmentAdapter.stop(environmentId, sessionId): Promise<DeliveryReceipt>`

- [ ] Route current Tailscale identity authentication through the environment adapter.
- [ ] Add optional `TRUSTED_TAILSCALE_USERS` allowlist; default behavior remains the operator's own tailnet identity.
- [ ] Return explicit `401`, `403`, offline, and upstream timeout states.
- [ ] Verify two local Aside hosts can be listed and selected without exposing tokens to the PWA.

### Task 4: Multi-tailnet relay and outbound connector

**Files:**
- Create: `src/relay/server.ts`
- Create: `src/relay/protocol.ts`
- Create: `src/connector/index.ts`
- Create: `src/connector/pairing.ts`
- Create: `tests/relay.test.ts`
- Create: `tests/connector.test.ts`
- Modify: `package.json`

**Interfaces:**
- `POST /api/pairing/start -> { code, expiresAt }`
- `POST /api/pairing/consume -> { connectorId, environment }`
- Connector WebSocket messages: `register`, `heartbeat`, `request`, `response`, `event`, `disconnect`.
- Every request contains `connectorId`, `requestId`, `method`, and a server-issued scope; connector rejects other IDs.

- [ ] Write failing tests for one-time pairing, expiry, connector scope, replayed request IDs, and disconnect state.
- [ ] Implement outbound connector connection so hosts behind different tailnets never require inbound ports.
- [ ] Store only hashed pairing codes and connector public identity; do not store Aside tokens or cookies.
- [ ] Add relay deployment configuration with loopback-disabled only for the relay's HTTPS endpoint, never for the connector's local Aside bridge.
- [ ] Verify two synthetic connectors on separate logical networks can register, list independently, and receive only their own requests.

### Task 5: Environment management UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `public/environment-pairing.js`

**Interfaces:**
- `Add environment` shows a one-time code/QR.
- `Environment menu`: rename, reconnect, revoke.
- Environment cards never display tokens or connector secrets.

- [ ] Add pair flow with expiry countdown and success/failure states.
- [ ] Add rename and revoke operations with explicit confirmation for revoke.
- [ ] Add environment capability badges and disable unsupported buttons.
- [ ] Verify mobile layout at iPhone width using iPhone Mirroring.

### Task 6: Optional browser tools behind the selected environment

**Files:**
- Modify: `src/aside-bridge.ts`
- Modify: `src/relay/protocol.ts`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `tests/aside-bridge.test.ts`

**Interfaces:**
- `GET /api/environments/:id/tabs`
- `GET /api/environments/:id/tabs/:tabId/dom`
- `POST /api/environments/:id/tabs/:tabId/screenshot`
- `POST /api/environments/:id/tabs/:tabId/action`

- [ ] Move browser calls from host IDs to environment IDs.
- [ ] Keep DOM projection and screenshots explicit user actions.
- [ ] Reject tab actions if environment selection changed since the tab was read.
- [ ] Verify stale environment/tab IDs fail without acting on another environment.

### Task 7: Deployment, migration, and acceptance

**Files:**
- Modify: `README.md`
- Create: `.env.example` updates
- Create: `docs/architecture.md`
- Create: `docs/security.md`

- [ ] Document direct same-tailnet mode, relay mode, pairing, revocation, and connector lifecycle.
- [ ] Provide a public-host deployment example for the relay and a per-Mac launchd connector setup.
- [ ] Verify no personal paths, hostnames, account names, tokens, cookies, or logs enter the repository.
- [ ] Run `bun test`, server/client bundles, direct Mac smoke test, and iPhone Mirroring acceptance flow.
- [ ] Acceptance: choose environment → choose session → read structured output → send prompt → see state update; browser tools remain optional.
