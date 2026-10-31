// Auto route: before a person's turn, a bot named in `autoRoute.bots` asks an external classifier which engine should
// answer and moves its thread there; a leading `@alias` forces one instead. Everything after the switch is the harness's
// own: the thread record replays to the engine that joins mid-thread, and a usage limit falls through to the bot's backups.
import type { ModelSelection } from "../shared/wire.ts";

export interface AutoRouteConfig {
  /** POST endpoint answering `{ cadena: string[], ruta?: string, motivo?: string }` for an OpenAI-style `{ messages }` body;
   * each chain entry is `provider/model`, best first. */
  url: string;
  /** Environment variable holding the bearer token; the token itself never sits in config.json. */
  tokenEnv?: string;
  /** Bot names that route themselves. */
  bots: string[];
  /** Chain provider → engine selection. `*` takes any provider not listed; a provider with no entry and no `*` is skipped. */
  engines: Record<string, ModelSelection>;
  /** `@alias` → a key of `engines`, e.g. `{ "claude": "claude", "gpt": "chatgpt" }`. */
  aliases?: Record<string, string>;
  timeoutMs?: number;
}

export interface RouteChoice {
  selection: ModelSelection;
  /** The turn's text with a forcing `@alias` removed. */
  text: string;
  why: string;
}

/** A leading `@alias` (case-insensitive) that names a configured engine, and the text without it. */
export function forcedEngine(text: string, config: AutoRouteConfig): { key: string; text: string } | null {
  const match = /^\s*@([\w-]+)\b\s*/.exec(text);
  const key = match && config.aliases?.[match[1].toLowerCase()];
  return key && config.engines[key] ? { key, text: text.slice(match[0].length) } : null;
}

/** The first chain entry whose engine is not blocked, as a selection; entries that map to the same engine count once. */
export function engineForChain(chain: string[], config: AutoRouteConfig, blocked: (instanceId: string) => boolean): ModelSelection | null {
  for (const entry of chain) {
    const selection = config.engines[entry.split("/")[0]] ?? config.engines["*"];
    if (selection && !blocked(selection.instanceId)) return selection;
  }
  return null;
}

/** Where this turn should run, or null to leave the thread where it is (no rule, classifier down, every engine blocked). */
export async function chooseRoute(text: string, config: AutoRouteConfig, deps: {
  blocked: (instanceId: string) => boolean;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<RouteChoice | null> {
  const forced = forcedEngine(text, config);
  if (forced) return { selection: config.engines[forced.key], text: forced.text, why: `@${forced.key}` };
  const token = config.tokenEnv ? (deps.env ?? process.env)[config.tokenEnv] : undefined;
  try {
    const response = await (deps.fetch ?? fetch)(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    if (!response.ok) return null;
    const answer = await response.json() as { cadena?: unknown; ruta?: unknown; motivo?: unknown };
    if (!Array.isArray(answer.cadena)) return null;
    const selection = engineForChain(answer.cadena.filter((entry) => typeof entry === "string"), config, deps.blocked);
    const why = [answer.ruta, answer.motivo].filter((part) => typeof part === "string" && part).join(" · ");
    return selection ? { selection, text, why } : null;
  } catch {
    return null;
  }
}
