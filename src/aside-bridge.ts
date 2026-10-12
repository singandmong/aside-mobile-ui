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

  async exec(hostId: string, prompt: string): Promise<{ ok: true }> {
    if (prompt.length === 0 || prompt.length > MAX_TEXT) throw new Error("Invalid prompt");
    return this.runCommand(["--host", hostId, prompt]);
  }

  async resume(hostId: string, sessionId: string, prompt: string): Promise<{ ok: true }> {
    if (prompt.length === 0 || prompt.length > MAX_TEXT) throw new Error("Invalid prompt");
    return this.runCommand(["--host", hostId, "session", "resume", sessionId, prompt]);
  }

  async stop(hostId: string, sessionId: string): Promise<{ ok: true }> {
    return this.runCommand(["--host", hostId, "session", "stop", sessionId]);
  }

  private async run(args: string[], code: string): Promise<unknown> {
    const proc = Bun.spawn([this.bin, ...args, code], { stdout: "pipe", stderr: "pipe" });
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

  async hosts(): Promise<Host[]> {
    const proc = Bun.spawn([this.bin, "host", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) throw new Error("Unable to list Aside hosts");
    return parseHostList(stdout);
  }

  private hostArgs(hostId: string): string[] {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(hostId)) throw new Error("Invalid host id");
    return ["repl", "--host", hostId];
  }

  async tabs(hostId: string): Promise<unknown> {
    return this.run(this.hostArgs(hostId), `console.log(${quote(RESULT_MARKER)}+JSON.stringify((await listBrowserTabs()).map(t=>({targetId:t.targetId,title:t.title,url:t.url,active:t.active}))));`);
  }

  async sessions(hostId: string): Promise<unknown> {
    return this.run(this.hostArgs(hostId), `console.log(${quote(RESULT_MARKER)}+JSON.stringify(aside.sessions.list({limit:50}).map(s=>({id:s.id,title:s.title,status:s.status,updatedAt:s.updatedAt}))));`);
  }

  async messages(hostId: string, sessionId: string): Promise<unknown> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) throw new Error("Invalid session id");
    return this.run(this.hostArgs(hostId), `const m=await aside.sessions.messages(${quote(sessionId)},{limit:100,order:"asc"}); console.log(${quote(RESULT_MARKER)}+JSON.stringify(m));`);
  }

  async dom(hostId: string, targetId: string): Promise<DomProjection> {
    const script = `const p=await attachBrowserTab(${quote(targetId)}); const d=await p.evaluate(()=>({title:document.title,url:location.href,text:(document.body.innerText||"").slice(0,50000),blocks:[...document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote")].slice(0,200).map(e=>({tag:e.tagName.toLowerCase(),text:(e.textContent||"").trim().slice(0,5000)})),links:[...document.querySelectorAll("a")].slice(0,200).map(e=>({text:(e.textContent||"").trim().slice(0,500),href:e.getAttribute("href")||""})),inputs:[...document.querySelectorAll("input,textarea,select")].slice(0,100).map(e=>({type:e.tagName.toLowerCase()==="input"?(e.getAttribute("type")||"text"):e.tagName.toLowerCase(),placeholder:e.getAttribute("placeholder")||""}))})); console.log(${quote(RESULT_MARKER)}+JSON.stringify(d));`;
    const output = await this.run(this.hostArgs(hostId), script);
    return parseDomProjection(JSON.stringify(output));
  }
  async screenshot(hostId: string, targetId: string): Promise<unknown> {
    return this.run(this.hostArgs(hostId), `const p=await attachBrowserTab(${quote(targetId)}); const b=await p.screenshot(); console.log(${quote(RESULT_MARKER)}+JSON.stringify({mime:"image/png",data:Buffer.from(b).toString("base64")}));`);
  }

  async action(hostId: string, targetId: string, action: BrowserAction): Promise<unknown> {
    const script = action.action === "click"
      ? `const p=await attachBrowserTab(${quote(targetId)}); await p.mouse.click(${action.x},${action.y});`
      : action.action === "scroll"
        ? `const p=await attachBrowserTab(${quote(targetId)}); await p.mouse.wheel(${action.dx},${action.dy});`
        : action.action === "type"
          ? `const p=await attachBrowserTab(${quote(targetId)}); await p.keyboard.type(${quote(action.text)});`
          : `const p=await attachBrowserTab(${quote(targetId)}); await p.keyboard.press(${quote(action.key)});`;
    return this.run(this.hostArgs(hostId), `${script} console.log(${quote(RESULT_MARKER)}+JSON.stringify({ok:true}));`);
  }
}
