// Auto route: before a person's turn, a bot named in `autoRoute.bots` asks an external classifier which engine of its
// own set should answer and moves its thread there; a leading `@alias` forces one instead. Everything after the switch is
// the harness's own: the thread record replays to the engine that joins mid-thread, and a usage limit falls through to the
// bot's backups.
import type { ModelSelection } from "../shared/wire.ts";

/** Chain provider → engine selection. `*` takes any provider not listed; a provider with no entry and no `*` is skipped. */
export type EngineMap = Record<string, ModelSelection>;

export interface AutoRouteConfig {
  /** POST endpoint answering `{ cadena: string[], ruta?: string, nivel?: string, motivo?: string }` (`motivo` already says
   * the route and level; they stand in when it is missing) for an OpenAI-style `{ messages }` body;
   * each chain entry is `provider/model`, best first. */
  url: string;
  /** Environment variable holding the bearer token; the token itself never sits in config.json. */
  tokenEnv?: string;
  /** Bots that route themselves, each with the name of its engine set, e.g. `{ "Auto": "local", "Studio": "remote" }`. */
  bots: Record<string, string>;
  /** Engine sets by name. A bot only ever uses its own set, so a provider missing from it never reaches another machine. */
  engines: Record<string, EngineMap>;
  /** `@alias` → a key of an engine set, e.g. `{ "claude": "claude", "gpt": "chatgpt" }`. */
  aliases?: Record<string, string>;
  timeoutMs?: number;
}

/** One bot's routing: the shared settings with its engine set. */
export type BotRoute = Omit<AutoRouteConfig, "bots" | "engines"> & { engines: EngineMap };

/** The routing for a bot, or null when it does not route itself. */
export function routeForBot(config: AutoRouteConfig | undefined, botName: string): BotRoute | null {
  const engines = config && Object.hasOwn(config.bots, botName) ? config.engines[config.bots[botName]!] : undefined;
  return engines ? { ...config!, engines } : null;
}

export interface RouteChoice {
  selection: ModelSelection;
  /** The turn's text with a forcing `@alias` removed. */
  text: string;
  why: string;
}

/** A leading `@alias` (case-insensitive) that names a configured engine, and the text without it. */
export function forcedEngine(text: string, config: BotRoute): { key: string; text: string } | null {
  const match = /^\s*@([\w-]+)\b\s*/.exec(text);
  const key = match && config.aliases?.[match[1].toLowerCase()];
  return key && config.engines[key] ? { key, text: text.slice(match[0].length) } : null;
}

/** The first chain entry whose engine is not blocked, with that engine; entries that map to the same engine count once. */
export function engineForChain(chain: string[], config: BotRoute, blocked: (instanceId: string) => boolean): { entry: string; selection: ModelSelection } | null {
  for (const entry of chain) {
    const selection = config.engines[entry.split("/")[0]] ?? config.engines["*"];
    if (selection && !blocked(selection.instanceId)) return { entry, selection };
  }
  return null;
}

/** Where this turn should run, or null to leave the thread where it is (no rule, classifier down, every engine blocked). */
export async function chooseRoute(text: string, config: BotRoute, deps: {
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
    const answer = await response.json() as { cadena?: unknown; ruta?: unknown; nivel?: unknown; motivo?: unknown };
    if (!Array.isArray(answer.cadena)) return null;
    const picked = engineForChain(answer.cadena.filter((entry) => typeof entry === "string"), config, deps.blocked);
    // The picked entry names the model even when the engine is a router (`agent-default`) that resolves it itself.
    const str = (part: unknown) => typeof part === "string" && part ? part : "";
    const why = [picked?.entry, str(answer.motivo) || [answer.ruta, answer.nivel].map(str).filter(Boolean).join("/")]
      .filter(Boolean).join(" · ");
    return picked ? { selection: picked.selection, text, why } : null;
  } catch {
    return null;
  }
}
