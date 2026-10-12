import os from "node:os";
import { normalizeMessages, toEnvironment, type EnvironmentSummary, type SessionMessage } from "./environment";

const RESULT_MARKER = "__ASIDE_MOBILE_RESULT__";
const MAX_TEXT = 5_000;
const MAX_OUTPUT = 2_000_000;

export type Host = {
  id: string;
  deviceName: string;
  platform: string;
  online: boolean;
  remoteControlEnabled: boolean;
};

export type BrowserAction =
  | { action: "click"; x: number; y: number }
  | { action: "scroll"; dx: number; dy: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string };

export type DomProjection = {
  title: string;
  url: string;
  text: string;
  blocks: { tag: string; text: string }[];
  links: { text: string; href: string }[];
  inputs: { type: string; placeholder: string }[];
};

export function parseDomProjection(value: string): DomProjection {
  const parsed = JSON.parse(value) as Partial<DomProjection>;
  if (typeof parsed.title !== "string" || typeof parsed.url !== "string" || typeof parsed.text !== "string" || !Array.isArray(parsed.blocks) || !Array.isArray(parsed.links) || !Array.isArray(parsed.inputs)) throw new Error("Invalid DOM projection");
  return {
    title: parsed.title.slice(0, 500),
    url: parsed.url.slice(0, 2_000),
    text: parsed.text.slice(0, 50_000),
    blocks: parsed.blocks.flatMap((block) => block && typeof block === "object" && typeof block.tag === "string" && typeof block.text === "string" ? [{ tag: block.tag.slice(0, 20), text: block.text.slice(0, 5_000) }] : []),
    links: parsed.links.flatMap((link) => link && typeof link === "object" && typeof link.text === "string" && typeof link.href === "string" ? [{ text: link.text.slice(0, 500), href: link.href.slice(0, 2_000) }] : []),
    inputs: parsed.inputs.flatMap((input) => input && typeof input === "object" && typeof input.type === "string" && typeof input.placeholder === "string" ? [{ type: input.type.slice(0, 30), placeholder: input.placeholder.slice(0, 500) }] : []),
  };
}

export function parseHostList(value: string): Host[] {
  const parsed = JSON.parse(value) as { hosts?: unknown };
  if (!Array.isArray(parsed.hosts)) return [];
  return parsed.hosts.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const host = item as Record<string, unknown>;
    if (typeof host.id !== "string" || typeof host.deviceName !== "string") return [];
    return [{
      id: host.id,
      deviceName: host.deviceName,
      platform: typeof host.platform === "string" ? host.platform : "unknown",
      online: host.online === true,
      remoteControlEnabled: host.remoteControlEnabled === true,
    }];
  });
}

export function parseResult(stdout: string): unknown {
  const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) throw new Error("Aside returned no structured result");
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

export type SessionSummary = { id: string; status: string; kind: string; title: string; updatedAt: string };

const ANSI = /\u001b\[[0-9;]*m/g;

/** Parses `aside session list` rows: `<id> <status> <kind> <title…> <ISO timestamp>`. Newest first. */
export function parseSessionList(stdout: string): SessionSummary[] {
  return stdout.replace(ANSI, "").split("\n").flatMap((line) => {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5 || !/^[A-Za-z0-9_-]{8,64}$/.test(tokens[0]) || !/^\d{4}-\d{2}-\d{2}T/.test(tokens[tokens.length - 1])) return [];
    return [{ id: tokens[0], status: tokens[1], kind: tokens[2], title: tokens.slice(3, -1).join(" "), updatedAt: tokens[tokens.length - 1] }];
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function parseCreatedSession(stdout: string): string | null {
  return stdout.replace(ANSI, "").match(/created new session:\s*([A-Za-z0-9_-]{8,64})/)?.[1] ?? null;
}

/** True when the Aside host is this machine. Remote-control round trips to yourself are ~40x slower than the local daemon. */
export function isLocalHost(host: Host, hostname: string, overrideId?: string): boolean {
  if (overrideId) return host.id === overrideId;
  const strip = (name: string) => name.toLowerCase().replace(/\.local$/, "");
  return strip(host.deviceName) === strip(hostname);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateBrowserAction(value: unknown): BrowserAction {
  if (!value || typeof value !== "object") throw new Error("Invalid browser action");
  const input = value as Record<string, unknown>;
  if (input.action === "click" && finite(input.x) && finite(input.y) && input.x >= 0 && input.y >= 0 && input.x <= 20_000 && input.y <= 20_000) {
    return { action: "click", x: input.x, y: input.y };
  }
  if (input.action === "scroll" && finite(input.dx) && finite(input.dy) && Math.abs(input.dx) <= 20_000 && Math.abs(input.dy) <= 20_000) {
    return { action: "scroll", dx: input.dx, dy: input.dy };
  }
  if (input.action === "type" && typeof input.text === "string" && input.text.length <= MAX_TEXT) {
    return { action: "type", text: input.text };
  }
  if (input.action === "key" && typeof input.key === "string" && input.key.length > 0 && input.key.length <= 50) {
    return { action: "key", key: input.key };
  }
  throw new Error("Invalid browser action");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export class AsideBridge {
  constructor(private readonly bin = process.env.ASIDE_BIN || "aside") {}
  private async runCommand(args: string[]): Promise<{ ok: true }> {
    const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (exitCode !== 0 || stdout.length > MAX_OUTPUT) throw new Error("Aside command failed");
    return { ok: true };
  }

  /**
   * Starts a long-running Aside task; resolves once the CLI reports the session (or a short grace period passes
   * without failure). Aside prints "created new session: <id>" on stderr. Both pipes keep draining so the task never blocks.
   */
  private async startCommand(args: string[], waitForSessionId: boolean): Promise<{ accepted: true; sessionId: string | null }> {
    const proc = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let seen = "";
    const found = Promise.withResolvers<string | null>();
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of stream) {
          seen = (seen + decoder.decode(chunk, { stream: true })).slice(-4_000);
          const sessionId = parseCreatedSession(seen);
          if (sessionId) found.resolve(sessionId);
        }
      } catch {}
    };
    void Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(() => found.resolve(null));
    const sessionId = await Promise.race([found.promise, Bun.sleep(waitForSessionId ? 20_000 : 2_000).then(() => null)]);
    const early = await Promise.race([proc.exited, Bun.sleep(0).then(() => null)]);
    if (!sessionId && early !== null && early !== 0) throw new Error("Aside command failed");
    return { accepted: true, sessionId };
  }

  async exec(hostId: string, prompt: string): Promise<{ accepted: true; sessionId: string | null }> {
    if (prompt.length === 0 || prompt.length > MAX_TEXT) throw new Error("Invalid prompt");
    return this.startCommand(["exec", ...(await this.hostFlag(hostId)), prompt], true);
  }

  async resume(hostId: string, sessionId: string, prompt: string): Promise<{ accepted: true; sessionId: string | null }> {
    if (prompt.length === 0 || prompt.length > MAX_TEXT) throw new Error("Invalid prompt");
    await this.startCommand([...(await this.hostFlag(hostId)), "session", "resume", sessionId, prompt], false);
    return { accepted: true, sessionId };
  }

  async stop(hostId: string, sessionId: string): Promise<{ ok: true }> {
    return this.runCommand([...(await this.hostFlag(hostId)), "session", "stop", sessionId]);
  }

  private async run(hostId: string, code: string): Promise<unknown> {
    const proc = Bun.spawn([this.bin, "repl", ...(await this.hostFlag(hostId)), code], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Aside command failed (${exitCode})`);
    if (stdout.length > MAX_OUTPUT) throw new Error("Aside response too large");
    try {
      return parseResult(stdout);
    } catch {
      if (stderr.length > 0) throw new Error("Aside returned an invalid result");
      throw new Error("Aside returned an invalid result");
    }
  }

  // `aside host list` is a cloud lookup (~9s). Serve the last result and refresh in the background.
  private hostCache: { at: number; hosts: Host[] } | null = null;
  private hostRefresh: Promise<Host[]> | null = null;

  private fetchHosts(): Promise<Host[]> {
    this.hostRefresh ??= (async () => {
      try {
        const proc = Bun.spawn([this.bin, "host", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
        const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        if (exitCode !== 0) throw new Error("Aside command failed");
        const hosts = parseHostList(stdout);
        this.hostCache = { at: Date.now(), hosts };
        return hosts;
      } finally {
        this.hostRefresh = null;
      }
    })();
    return this.hostRefresh;
  }

  async hosts(): Promise<Host[]> {
    if (!this.hostCache) return this.fetchHosts();
    if (Date.now() - this.hostCache.at > 15_000) this.fetchHosts().catch(() => {});
    return this.hostCache.hosts;
  }

  async environments(): Promise<EnvironmentSummary[]> {
    return (await this.hosts()).map((host) => toEnvironment(host, this.isLocal(host) ? "local" : "aside-remote"));
  }

  private isLocal(host: Host): boolean {
    return isLocalHost(host, os.hostname(), process.env.ASIDE_LOCAL_HOST_ID);
  }

  /** The Aside host that is this machine, if Aside is running here with remote control enabled. */
  async localEnvironment(): Promise<EnvironmentSummary | null> {
    const host = (await this.hosts()).find((candidate) => this.isLocal(candidate));
    return host ? toEnvironment(host, "local") : null;
  }

  private async hostFlag(hostId: string): Promise<string[]> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(hostId)) throw new Error("Invalid host id");
    const host = (await this.hosts()).find((candidate) => candidate.id === hostId);
    if (!host) throw new Error("Invalid host id");
    return this.isLocal(host) ? [] : ["--host", hostId];
  }

  async tabs(hostId: string): Promise<unknown> {
    return this.run(hostId, `console.log(${quote(RESULT_MARKER)}+JSON.stringify((await listBrowserTabs()).map(t=>({targetId:t.targetId,title:t.title,url:t.url,active:t.active}))));`);
  }

  /** CLI listing includes phone-started (ephemeral) sessions that the REPL list hides. */
  async sessions(hostId: string): Promise<SessionSummary[]> {
    const proc = Bun.spawn([this.bin, ...(await this.hostFlag(hostId)), "session", "list"], { stdout: "pipe", stderr: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) throw new Error("Aside command failed");
    return parseSessionList(stdout).slice(0, 50);
  }

  /** Latest conversation turns, projected to role/text inside Aside so large channel transcripts never overflow REPL stdout. */
  async messages(hostId: string, sessionId: string): Promise<SessionMessage[]> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) throw new Error("Invalid session id");
    const script = `const m=await aside.sessions.messages(${quote(sessionId)},{limit:200,order:"desc"});`
      + `const t=(c)=>typeof c==="string"?c:Array.isArray(c)?c.filter(p=>p&&p.type==="text"&&typeof p.text==="string").map(p=>p.text).join("\\n"):"";`
      + `const out=m.filter(x=>x&&(x.role==="user"||x.role==="assistant")).map(x=>({role:x.role,content:t(x.content),timestamp:x.timestamp??null})).filter(x=>x.content).slice(0,60).reverse().map(x=>x.content.length>8000?{...x,content:x.content.slice(0,8000)+"\\n…"}:x);`
      + `console.log(${quote(RESULT_MARKER)}+JSON.stringify(out));`;
    return normalizeMessages(await this.run(hostId, script));
  }

  async dom(hostId: string, targetId: string): Promise<DomProjection> {
    const script = `const p=await attachBrowserTab(${quote(targetId)}); const d=await p.evaluate(()=>({title:document.title,url:location.href,text:(document.body.innerText||"").slice(0,50000),blocks:[...document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote")].slice(0,200).map(e=>({tag:e.tagName.toLowerCase(),text:(e.textContent||"").trim().slice(0,5000)})),links:[...document.querySelectorAll("a")].slice(0,200).map(e=>({text:(e.textContent||"").trim().slice(0,500),href:e.getAttribute("href")||""})),inputs:[...document.querySelectorAll("input,textarea,select")].slice(0,100).map(e=>({type:e.tagName.toLowerCase()==="input"?(e.getAttribute("type")||"text"):e.tagName.toLowerCase(),placeholder:e.getAttribute("placeholder")||""}))})); console.log(${quote(RESULT_MARKER)}+JSON.stringify(d));`;
    const output = await this.run(hostId, script);
    return parseDomProjection(JSON.stringify(output));
  }
  async screenshot(hostId: string, targetId: string): Promise<unknown> {
    return this.run(hostId, `const p=await attachBrowserTab(${quote(targetId)}); const b=await p.screenshot(); console.log(${quote(RESULT_MARKER)}+JSON.stringify({mime:"image/png",data:Buffer.from(b).toString("base64")}));`);
  }

  async action(hostId: string, targetId: string, action: BrowserAction): Promise<unknown> {
    const script = action.action === "click"
      ? `const p=await attachBrowserTab(${quote(targetId)}); await p.mouse.click(${action.x},${action.y});`
      : action.action === "scroll"
        ? `const p=await attachBrowserTab(${quote(targetId)}); await p.mouse.wheel(${action.dx},${action.dy});`
        : action.action === "type"
          ? `const p=await attachBrowserTab(${quote(targetId)}); await p.keyboard.type(${quote(action.text)});`
          : `const p=await attachBrowserTab(${quote(targetId)}); await p.keyboard.press(${quote(action.key)});`;
    return this.run(hostId, `${script} console.log(${quote(RESULT_MARKER)}+JSON.stringify({ok:true}));`);
  }
}
