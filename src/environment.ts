import type { Host } from "./aside-bridge";

/** local: this machine's Aside daemon (fast). aside-remote: Aside's own cloud remote control (slow). relay: a paired connector on another machine. */
export type Connection = "local" | "aside-remote" | "relay";

export type EnvironmentCapabilities = {
  sessions: boolean;
  prompts: boolean;
  stop: boolean;
  browserTabs: boolean;
  domProjection: boolean;
  screenshot: boolean;
  browserActions: boolean;
};

export type EnvironmentSummary = {
  id: string;
  label: string;
  platform: string;
  online: boolean;
  connection: Connection;
  capabilities: EnvironmentCapabilities;
};

export type SessionMessage = { role: "user" | "assistant"; text: string; timestamp: number | string | null };

export function toEnvironment(host: Host, connection: Connection): EnvironmentSummary {
  const usable = host.online && host.remoteControlEnabled;
  return {
    id: host.id,
    label: host.deviceName.replace(/\.local$/i, ""),
    platform: host.platform,
    online: host.online,
    connection,
    capabilities: {
      sessions: usable,
      prompts: usable,
      stop: usable,
      browserTabs: usable,
      domProjection: usable,
      screenshot: usable,
      browserActions: usable,
    },
  };
}

export function normalizeMessages(value: unknown): SessionMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("role" in item) || !("content" in item)) return [];
    if (item.role !== "user" && item.role !== "assistant") return [];
    const content = item.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n")
        : "";
    if (!text) return [];
    const timestamp = "timestamp" in item && (typeof item.timestamp === "number" || typeof item.timestamp === "string") ? item.timestamp : null;
    return [{ role: item.role, text, timestamp }];
  });
}
