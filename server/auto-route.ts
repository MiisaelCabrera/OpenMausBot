// Auto route: classify recent conversation text using a route table or provider chain.
// Leading aliases pin the thread to an engine; @auto resumes classification.
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
  /** Classifier route → engine key; null keeps the current engine. */
  rutas?: Record<string, string | null>;
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
  selection?: ModelSelection;
  pin?: boolean;
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

/** Codex's tier standing in for a Claude model: Terra for Sonnet and Haiku, Sol for Opus and Fable. */
export function codexTier(claudeModel: string): string | undefined {
  return /opus|fable/i.test(claudeModel) ? "gpt-6.1-sol" : /sonnet|haiku/i.test(claudeModel) ? "gpt-6.1-terra" : undefined;
}

/** The `chatgpt` engine on the tier matching the thread's Claude model (the set's own Claude when the thread is elsewhere), when it offers it. */
function chatgptTier(selection: ModelSelection, config: BotRoute, deps: { currentModel?: string; offers?: (instanceId: string, model: string) => boolean }): ModelSelection {
  if (selection !== config.engines.chatgpt) return selection;
  const claude = /claude/i.test(deps.currentModel ?? "") ? deps.currentModel! : config.engines.claude?.model ?? "";
  const tier = codexTier(claude);
  return tier && deps.offers?.(selection.instanceId, tier) ? { instanceId: selection.instanceId, model: tier } : selection;
}

/** A route or pin change; null leaves the thread and its pin unchanged. */
export async function chooseRoute(text: string, config: BotRoute, deps: {
  blocked: (instanceId: string) => boolean;
  pinned: boolean;
  /** The thread's model now, and whether an engine offers a model: Auto maps Claude's tiers to Codex's. */
  currentModel?: string;
  offers?: (instanceId: string, model: string) => boolean;
  history?: Array<string | { role: "user" | "assistant"; content: string }>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<RouteChoice | null> {
  const auto = /^\s*@auto\b\s*/i.exec(text);
  if (auto) text = text.slice(auto[0].length);
  const unchanged: RouteChoice | null = auto ? { text, why: "", pin: false } : null;
  const forced = auto ? null : forcedEngine(text, config);
  if (forced) return { selection: chatgptTier(config.engines[forced.key], config, deps), text: forced.text, why: `@${forced.key}`, pin: true };
  if (deps.pinned && !auto) return null;
  const token = config.tokenEnv ? (deps.env ?? process.env)[config.tokenEnv] : undefined;
  try {
    const response = await (deps.fetch ?? fetch)(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ messages: [
        ...(deps.history ?? []).slice(-4).map((message) => typeof message === "string"
          ? { role: "user", content: message.slice(0, 500) }
          : { role: message.role, content: message.content.slice(0, 500) }),
        { role: "user", content: text.slice(0, 2000) },
      ] }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    if (!response.ok) return unchanged;
    const answer = await response.json() as { cadena?: unknown; ruta?: unknown; nivel?: unknown; motivo?: unknown };
    const mapped = typeof answer.ruta === "string" && config.rutas && Object.hasOwn(config.rutas, answer.ruta);
    const key = mapped ? config.rutas![answer.ruta as string] : null;
    const selection = key != null ? config.engines[key] : undefined;
    const picked = mapped
      ? selection && !deps.blocked(selection.instanceId) ? { entry: `${answer.ruta}→${key}`, selection } : null
      : Array.isArray(answer.cadena) ? engineForChain(answer.cadena.filter((entry) => typeof entry === "string"), config, deps.blocked) : null;
    // The picked entry names the model even when the engine is a router (`agent-default`) that resolves it itself.
    const str = (part: unknown) => typeof part === "string" && part ? part : "";
    const why = [picked?.entry, str(answer.motivo) || [answer.ruta, answer.nivel].map(str).filter(Boolean).join("/")]
      .filter(Boolean).join(" · ");
    return picked ? { selection: chatgptTier(picked.selection, config, deps), text, why, ...(auto ? { pin: false } : {}) } : unchanged;
  } catch {
    return unchanged;
  }
}
