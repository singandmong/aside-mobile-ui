import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { BrowserAction } from "./aside-bridge";
import type { EnvironmentSummary } from "./environment";
import { parseConnectorMessage, type RelayMethod, type RelayRequest } from "./protocol";
import type { EnvironmentBackend } from "./server";

const PAIRING_TTL_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;
const RELAY_PREFIX = "relay~";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type ConnectorRecord = { id: string; label: string; secretHash: string; createdAt: string };
type SocketData = { connectorId: string };
type Live = { ws: ServerWebSocket<SocketData>; environment: EnvironmentSummary | null; lastSeen: number };
type Waiting = { connectorId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: Timer };

export type ConnectorInfo = { id: string; label: string; createdAt: string; online: boolean; environment: EnvironmentSummary | null };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class RelayHub {
  private connectors: ConnectorRecord[] = [];
  private readonly pairings = new Map<string, number>();
  private readonly live = new Map<string, Live>();
  private readonly waiting = new Map<string, Waiting>();
  private failedPairings: number[] = [];

  constructor(private readonly storePath: string | null, private readonly now: () => number = Date.now) {
    if (storePath && existsSync(storePath)) this.connectors = JSON.parse(readFileSync(storePath, "utf8")).connectors ?? [];
  }

  private save(): void {
    if (!this.storePath) return;
    mkdirSync(dirname(this.storePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.storePath, JSON.stringify({ connectors: this.connectors }, null, 2), { mode: 0o600 });
    chmodSync(this.storePath, 0o600);
  }

  /** One-time code shown on the phone and typed on the machine that runs the connector. */
  startPairing(): { code: string; expiresAt: number } {
    for (const [hash, expiresAt] of this.pairings) if (expiresAt < this.now()) this.pairings.delete(hash);
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pairings.set(sha256(code), expiresAt);
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  consumePairing(code: string, label: string): { connectorId: string; secret: string } | null {
    this.failedPairings = this.failedPairings.filter((at) => at > this.now() - 60_000);
    if (this.failedPairings.length >= 10) return null;
    const hash = sha256(normalizeCode(code));
    const expiresAt = this.pairings.get(hash);
    if (!expiresAt || expiresAt < this.now()) { this.failedPairings.push(this.now()); return null; }
    this.pairings.delete(hash);
    const connectorId = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    this.connectors.push({ id: connectorId, label: label.trim().slice(0, 60) || "Aside computer", secretHash: sha256(secret), createdAt: new Date(this.now()).toISOString() });
    this.save();
    return { connectorId, secret };
  }

  authenticate(authorization: string | null): string | null {
    const match = authorization?.match(/^Bearer ([a-f0-9]{12})\.([A-Za-z0-9_-]{20,})$/);
    if (!match) return null;
    const record = this.connectors.find((connector) => connector.id === match[1]);
    return record && sameHash(record.secretHash, sha256(match[2])) ? record.id : null;
  }

  list(): ConnectorInfo[] {
    return this.connectors.map((record) => ({ id: record.id, label: record.label, createdAt: record.createdAt, online: this.live.has(record.id), environment: this.live.get(record.id)?.environment ?? null }));
  }

  revoke(connectorId: string): boolean {
    const before = this.connectors.length;
    this.connectors = this.connectors.filter((record) => record.id !== connectorId);
    if (this.connectors.length === before) return false;
    this.save();
    this.live.get(connectorId)?.ws.close(4001, "revoked");
    this.live.delete(connectorId);
    return true;
  }

  upgrade(request: Request, server: Server): boolean {
    const connectorId = this.authenticate(request.headers.get("authorization"));
    return connectorId !== null && server.upgrade(request, { data: { connectorId } });
  }

  readonly websocket = {
    open: (ws: ServerWebSocket<SocketData>) => {
      this.live.get(ws.data.connectorId)?.ws.close(4000, "replaced");
      this.live.set(ws.data.connectorId, { ws, environment: null, lastSeen: this.now() });
    },
    message: (ws: ServerWebSocket<SocketData>, raw: string | Buffer) => {
      const live = this.live.get(ws.data.connectorId);
      if (!live || live.ws !== ws) return;
      live.lastSeen = this.now();
      const message = parseConnectorMessage(String(raw));
      if (!message) return;
      if (message.type === "hello") { live.environment = message.environment; return; }
      const waiting = this.waiting.get(message.id);
      if (!waiting || waiting.connectorId !== ws.data.connectorId) return;
      this.waiting.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(message.error === "bad_request" ? "Invalid relay request" : message.error === "environment_offline" ? "environment_offline" : "Aside unavailable"));
    },
    close: (ws: ServerWebSocket<SocketData>) => {
      if (this.live.get(ws.data.connectorId)?.ws !== ws) return;
      this.live.delete(ws.data.connectorId);
      for (const [id, waiting] of this.waiting) {
        if (waiting.connectorId !== ws.data.connectorId) continue;
        this.waiting.delete(id);
        clearTimeout(waiting.timer);
        waiting.reject(new Error("environment_offline"));
      }
    },
  };

  call(connectorId: string, method: RelayMethod, params: unknown[], timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const live = this.live.get(connectorId);
    if (!live || !this.connectors.some((record) => record.id === connectorId)) return Promise.reject(new Error("environment_offline"));
    const id = randomBytes(8).toString("hex");
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("environment_timeout")); }, timeoutMs);
    this.waiting.set(id, { connectorId, resolve, reject, timer });
    const request: RelayRequest = { type: "request", id, method, params };
    live.ws.send(JSON.stringify(request));
    return promise;
  }

  /** Aside host ids that are reachable through a live connector (used to hide slower duplicates). */
  relayedHostIds(): Set<string> {
    return new Set([...this.live.values()].flatMap((live) => (live.environment ? [live.environment.id] : [])));
  }

  environments(): EnvironmentSummary[] {
    return this.connectors.map((record) => {
      const environment = this.live.get(record.id)?.environment;
      if (environment) return { ...environment, id: `${RELAY_PREFIX}${record.id}`, label: record.label, connection: "relay" as const };
      return {
        id: `${RELAY_PREFIX}${record.id}`, label: record.label, platform: "unknown", online: false, connection: "relay" as const,
        capabilities: { sessions: false, prompts: false, stop: false, browserTabs: false, domProjection: false, screenshot: false, browserActions: false },
      };
    });
  }
}

/** Phone-facing backend for a hub: this machine's Aside plus every paired connector. */
export class HubBackend implements EnvironmentBackend {
  constructor(private readonly local: EnvironmentBackend, private readonly hub: RelayHub) {}

  async environments(): Promise<EnvironmentSummary[]> {
    const relayed = this.hub.relayedHostIds();
    const local = await this.local.environments().catch(() => []);
    return [...local.filter((environment) => !relayed.has(environment.id)), ...this.hub.environments()];
  }

  private connector(environmentId: string): string | null {
    return environmentId.startsWith(RELAY_PREFIX) ? environmentId.slice(RELAY_PREFIX.length) : null;
  }

  private via<T>(environmentId: string, method: RelayMethod, params: unknown[], local: () => Promise<T>): Promise<unknown> {
    const connectorId = this.connector(environmentId);
    return connectorId ? this.hub.call(connectorId, method, params) : local();
  }

  tabs(environmentId: string) { return this.via(environmentId, "tabs", [], () => this.local.tabs(environmentId)); }
  sessions(environmentId: string) { return this.via(environmentId, "sessions", [], () => this.local.sessions(environmentId)); }
  messages(environmentId: string, sessionId: string) { return this.via(environmentId, "messages", [sessionId], () => this.local.messages(environmentId, sessionId)); }
  screenshot(environmentId: string, targetId: string) { return this.via(environmentId, "screenshot", [targetId], () => this.local.screenshot(environmentId, targetId)); }
  dom(environmentId: string, targetId: string) { return this.via(environmentId, "dom", [targetId], () => this.local.dom(environmentId, targetId)); }
  action(environmentId: string, targetId: string, action: BrowserAction) { return this.via(environmentId, "action", [targetId, action], () => this.local.action(environmentId, targetId, action)); }
  exec(environmentId: string, prompt: string) { return this.via(environmentId, "exec", [prompt], () => this.local.exec(environmentId, prompt)); }
  resume(environmentId: string, sessionId: string, prompt: string) { return this.via(environmentId, "resume", [sessionId, prompt], () => this.local.resume(environmentId, sessionId, prompt)); }
  stop(environmentId: string, sessionId: string) { return this.via(environmentId, "stop", [sessionId], () => this.local.stop(environmentId, sessionId)); }
}
