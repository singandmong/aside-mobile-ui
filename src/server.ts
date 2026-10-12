import { AsideBridge, type BrowserAction, validateBrowserAction } from "./aside-bridge";

export interface AsideBridgeLike {
  hosts(): Promise<unknown>;
  tabs(hostId: string): Promise<unknown>;
  sessions(hostId: string): Promise<unknown>;
  messages(hostId: string, sessionId: string): Promise<unknown>;
  screenshot(hostId: string, targetId: string): Promise<unknown>;
  dom(hostId: string, targetId: string): Promise<unknown>;
  action(hostId: string, targetId: string, action: BrowserAction): Promise<unknown>;
  exec(hostId: string, prompt: string): Promise<unknown>;
  resume(hostId: string, sessionId: string, prompt: string): Promise<unknown>;
  stop(hostId: string, sessionId: string): Promise<unknown>;
}

type AppOptions = { bridge?: AsideBridgeLike; token?: string; publicDir?: string };

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function pathPart(value: string | undefined, label: string): string {
  if (!value || value.length > 200 || /[\\/]/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function promptFrom(value: unknown): string {
  if (!value || typeof value !== "object" || !("prompt" in value) || typeof value.prompt !== "string" || value.prompt.length === 0 || value.prompt.length > 5_000) throw new Error("Invalid prompt");
  return value.prompt;
}

function authorized(request: Request, token: string): boolean {
  return !token || request.headers.get("authorization") === `Bearer ${token}`;
}

async function staticFile(publicDir: string, pathname: string): Promise<Response> {
  const fileName = pathname === "/" ? "/index.html" : pathname;
  if (!/^\/(index\.html|app\.js|styles\.css|manifest\.webmanifest|sw\.js)$/.test(fileName)) return new Response("Not found", { status: 404 });
  const file = Bun.file(`${publicDir}${fileName}`);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, { headers: { "cache-control": fileName === "/index.html" ? "no-cache" : "public, max-age=300" } });
}

export function createApp(options: AppOptions = {}): (request: Request) => Promise<Response> {
  const bridge = options.bridge ?? new AsideBridge();
  const token = options.token ?? process.env.ASIDE_MOBILE_TOKEN ?? "";
  const publicDir = options.publicDir ?? `${process.cwd()}/public`;

  return async function app(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, service: "aside-mobile" });
    if (!url.pathname.startsWith("/api/")) return staticFile(publicDir, url.pathname);
    if (!authorized(request, token)) return json({ error: "unauthorized" }, 401);

    try {
      const segments = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && segments.length === 2 && segments[1] === "hosts") return json(await bridge.hosts());
      if (segments.length < 3 || segments[1] !== "hosts") return json({ error: "not_found" }, 404);
      const hostId = pathPart(segments[2], "host");
      if (request.method === "POST" && segments.length === 4 && segments[3] === "exec") {
        return json(await bridge.exec(hostId, promptFrom(await request.json())));
      }
      if (request.method === "POST" && segments.length === 6 && segments[3] === "sessions" && segments[5] === "resume") {
        return json(await bridge.resume(hostId, pathPart(segments[4], "session"), promptFrom(await request.json())));
      }
      if (request.method === "POST" && segments.length === 6 && segments[3] === "sessions" && segments[5] === "stop") {
        return json(await bridge.stop(hostId, pathPart(segments[4], "session")));
      }
      if (request.method === "GET" && segments.length === 4 && segments[3] === "tabs") return json(await bridge.tabs(hostId));
      if (request.method === "GET" && segments.length === 4 && segments[3] === "sessions") return json(await bridge.sessions(hostId));
      if (request.method === "GET" && segments.length === 6 && segments[3] === "sessions" && segments[5] === "messages") return json(await bridge.messages(hostId, pathPart(segments[4], "session")));
      if (segments.length < 5 || segments[3] !== "tabs") return json({ error: "not_found" }, 404);
      const targetId = pathPart(segments[4], "target");
      if (request.method === "GET" && segments.length === 6 && segments[3] === "tabs" && segments[5] === "dom") return json(await bridge.dom(hostId, targetId));
      if (request.method === "POST" && segments.length === 6 && segments[5] === "action") {
        const input = await request.json().catch(() => null);
        return json(await bridge.action(hostId, targetId, validateBrowserAction(input)));
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Invalid"))) return json({ error: "bad_request" }, 400);
      if (error instanceof Error && error.message.startsWith("Aside")) return json({ error: "aside_unavailable" }, 502);
      return json({ error: "upstream_unavailable" }, 502);
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const hostname = process.env.HOST ?? "127.0.0.1";
  const token = process.env.ASIDE_MOBILE_TOKEN;
  if (!token && process.env.ALLOW_INSECURE_LOCAL !== "1") throw new Error("Set ASIDE_MOBILE_TOKEN before starting, or use ALLOW_INSECURE_LOCAL=1 for local-only testing");
  const app = createApp({ token });
  Bun.serve({ hostname, port, idleTimeout: 30, fetch: app });
  console.log(`aside-mobile listening on http://${hostname}:${port}`);
}
