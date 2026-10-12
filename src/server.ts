import os from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { AsideBridge, type BrowserAction, validateBrowserAction } from "./aside-bridge";
import { HubBackend, RelayHub } from "./relay";
import type { EnvironmentSummary } from "./environment";

/** Environment-scoped operations. Implemented by the local Aside bridge (direct mode) and the relay (multi-tailnet mode). */
export interface EnvironmentBackend {
  environments(): Promise<EnvironmentSummary[]>;
  tabs(environmentId: string): Promise<unknown>;
  sessions(environmentId: string): Promise<unknown>;
  messages(environmentId: string, sessionId: string): Promise<unknown>;
  screenshot(environmentId: string, targetId: string): Promise<unknown>;
  dom(environmentId: string, targetId: string): Promise<unknown>;
  action(environmentId: string, targetId: string, action: BrowserAction): Promise<unknown>;
  exec(environmentId: string, prompt: string): Promise<unknown>;
  resume(environmentId: string, sessionId: string, prompt: string): Promise<unknown>;
  stop(environmentId: string, sessionId: string): Promise<unknown>;
}

export type AuthOptions = { token: string; trustTailscaleIdentity: boolean; trustedUsers: string[] };

type AppOptions = Partial<AuthOptions> & { backend?: EnvironmentBackend; publicDir?: string; relay?: RelayHub };

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function pathPart(value: string | undefined, label: string): string {
  if (!value || value.length > 300 || /[\\/]/.test(value)) throw new Error(`Invalid ${label}`);
  return decodeURIComponent(value);
}

function promptFrom(value: unknown): string {
  if (!value || typeof value !== "object" || !("prompt" in value) || typeof value.prompt !== "string" || value.prompt.length === 0 || value.prompt.length > 5_000) throw new Error("Invalid prompt");
  return value.prompt;
}

export function authorized(request: Request, auth: AuthOptions): boolean {
  const login = request.headers.get("Tailscale-User-Login");
  if (auth.trustTailscaleIdentity && login) {
    if (auth.trustedUsers.length === 0 || auth.trustedUsers.includes(login.toLowerCase())) return true;
  }
  if (!auth.token) return !auth.trustTailscaleIdentity;
  return request.headers.get("authorization") === `Bearer ${auth.token}`;
}

export function authFromEnv(): AuthOptions {
  return {
    token: process.env.ASIDE_MOBILE_TOKEN ?? "",
    trustTailscaleIdentity: process.env.TRUST_TAILSCALE_IDENTITY === "1",
    trustedUsers: (process.env.TRUSTED_TAILSCALE_USERS ?? "").split(",").map((user) => user.trim().toLowerCase()).filter(Boolean),
  };
}

async function staticFile(publicDir: string, pathname: string): Promise<Response> {
  const fileName = pathname === "/" ? "/index.html" : pathname;
  if (!/^\/(index\.html|app\.js|styles\.css|manifest\.webmanifest|sw\.js|icon\.svg)$/.test(fileName)) return new Response("Not found", { status: 404 });
  const file = Bun.file(`${publicDir}${fileName}`);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "cache-control": "no-cache" } });
}

async function routeEnvironment(backend: EnvironmentBackend, request: Request, segments: string[]): Promise<Response> {
  // segments: ["api", "environments", id, ...rest]
  const environmentId = pathPart(segments[2], "environment");
  const [resource, resourceId, verb] = segments.slice(3);
  const method = request.method;

  if (method === "POST" && resource === "exec" && !resourceId) return json(await backend.exec(environmentId, promptFrom(await request.json())));
  if (resource === "sessions") {
    if (method === "GET" && !resourceId) return json(await backend.sessions(environmentId));
    const sessionId = pathPart(resourceId, "session");
    if (method === "GET" && verb === "messages") return json(await backend.messages(environmentId, sessionId));
    if (method === "POST" && verb === "resume") return json(await backend.resume(environmentId, sessionId, promptFrom(await request.json())));
    if (method === "POST" && verb === "stop") return json(await backend.stop(environmentId, sessionId));
  }
  if (resource === "tabs") {
    if (method === "GET" && !resourceId) return json(await backend.tabs(environmentId));
    const targetId = pathPart(resourceId, "target");
    if (method === "GET" && verb === "dom") return json(await backend.dom(environmentId, targetId));
    if (method === "POST" && verb === "screenshot") return json(await backend.screenshot(environmentId, targetId));
    if (method === "POST" && verb === "action") return json(await backend.action(environmentId, targetId, validateBrowserAction(await request.json().catch(() => null))));
  }
  return json({ error: "not_found" }, 404);
}

export function createApp(options: AppOptions = {}): (request: Request, server?: Server) => Promise<Response | undefined> {
  const backend = options.backend ?? new AsideBridge();
  const env = authFromEnv();
  const auth: AuthOptions = {
    token: options.token ?? env.token,
    trustTailscaleIdentity: options.trustTailscaleIdentity ?? env.trustTailscaleIdentity,
    trustedUsers: options.trustedUsers ?? env.trustedUsers,
  };
  const publicDir = options.publicDir ?? `${import.meta.dir}/../public`;

  const relay = options.relay;

  return async function app(request: Request, server?: Server): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, service: "aside-mobile", relay: Boolean(relay) });
    if (relay && url.pathname === "/connect") {
      if (server && relay.upgrade(request, server)) return undefined;
      return json({ error: "unauthorized" }, 401);
    }
    if (relay && url.pathname === "/pair" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "";
      const label = body && typeof body === "object" && "label" in body && typeof body.label === "string" ? body.label : "";
      const paired = relay.consumePairing(code, label);
      return paired ? json(paired) : json({ error: "invalid_code" }, 403);
    }
    if (!url.pathname.startsWith("/api/")) return staticFile(publicDir, url.pathname);
    if (!authorized(request, auth)) return json({ error: "unauthorized" }, 401);

    try {
      const segments = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && segments.length === 2 && segments[1] === "environments") return json(await backend.environments());
      if (segments.length >= 3 && segments[1] === "environments") return await routeEnvironment(backend, request, segments);
      if (segments[1] === "pairing" || segments[1] === "connectors") {
        if (!relay) return json({ error: "relay_disabled" }, 404);
        if (request.method === "POST" && segments.length === 2 && segments[1] === "pairing") return json(relay.startPairing());
        if (request.method === "GET" && segments.length === 2 && segments[1] === "connectors") return json(relay.list());
        if (request.method === "DELETE" && segments.length === 3 && segments[1] === "connectors") return relay.revoke(pathPart(segments[2], "connector")) ? json({ ok: true }) : json({ error: "not_found" }, 404);
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Invalid"))) return json({ error: "bad_request" }, 400);
      if (error instanceof Error && error.message === "environment_offline") return json({ error: "environment_offline" }, 503);
      if (error instanceof Error && error.message === "environment_timeout") return json({ error: "environment_timeout" }, 504);
      return json({ error: "aside_unavailable" }, 502);
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const auth = authFromEnv();
  if (!auth.token && !auth.trustTailscaleIdentity && process.env.ALLOW_INSECURE_LOCAL !== "1") throw new Error("Set ASIDE_MOBILE_TOKEN or TRUST_TAILSCALE_IDENTITY=1 before starting");
  const local = new AsideBridge();
  local.environments().catch(() => {});
  const relay = process.env.ASIDE_MOBILE_RELAY === "1" ? new RelayHub(process.env.ASIDE_RELAY_STORE ?? join(os.homedir(), ".config", "aside-mobile", "relay.json")) : undefined;
  const backend = relay ? new HubBackend(local, relay) : local;
  const fetch = createApp({ ...auth, backend, relay });
  Bun.serve({ hostname, port, idleTimeout: 60, fetch, websocket: relay?.websocket ?? { message() {} } });
  console.log(`aside-mobile listening on http://${hostname}:${port}${relay ? " (relay hub enabled)" : ""}`);
}
