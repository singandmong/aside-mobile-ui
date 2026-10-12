import { validateBrowserAction } from "./aside-bridge";
import type { EnvironmentSummary } from "./environment";

/** Hub → connector. `params` never contains a host id; the connector always targets its own local Aside. */
export type RelayRequest = { type: "request"; id: string; method: RelayMethod; params: unknown[] };
/** Connector → hub. */
export type RelayResponse = { type: "response"; id: string; ok: true; result: unknown } | { type: "response"; id: string; ok: false; error: string };
export type RelayHello = { type: "hello"; environment: EnvironmentSummary | null };
export type ConnectorMessage = RelayResponse | RelayHello;

export const RELAY_METHODS = ["tabs", "sessions", "messages", "screenshot", "dom", "action", "exec", "resume", "stop"] as const;
export type RelayMethod = (typeof RELAY_METHODS)[number];

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;

/** Validates params on the connector side too, so a compromised hub cannot widen what the connector does. */
export function validateParams(method: string, params: unknown): unknown[] {
  if (!(RELAY_METHODS as readonly string[]).includes(method) || !Array.isArray(params)) throw new Error("Invalid relay request");
  const [a, b] = params;
  switch (method) {
    case "tabs":
    case "sessions":
      if (params.length === 0) return [];
      break;
    case "messages":
    case "stop":
      if (params.length === 1 && text(a, 200) && ID.test(a as string)) return [a];
      break;
    case "screenshot":
    case "dom":
      if (params.length === 1 && text(a, 300)) return [a];
      break;
    case "action":
      if (params.length === 2 && text(a, 300)) return [a, validateBrowserAction(b)];
      break;
    case "exec":
      if (params.length === 1 && text(a, 5_000)) return [a];
      break;
    case "resume":
      if (params.length === 2 && text(a, 200) && ID.test(a as string) && text(b, 5_000)) return [a, b];
      break;
  }
  throw new Error("Invalid relay request");
}

export function parseConnectorMessage(raw: string): ConnectorMessage | null {
  try {
    const message = JSON.parse(raw);
    if (message?.type === "hello") return { type: "hello", environment: message.environment ?? null };
    if (message?.type === "response" && typeof message.id === "string") {
      return message.ok === true ? { type: "response", id: message.id, ok: true, result: message.result } : { type: "response", id: message.id, ok: false, error: String(message.error ?? "error") };
    }
  } catch {}
  return null;
}
