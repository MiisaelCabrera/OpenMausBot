import { describe, expect, it, vi } from "vitest";

import { chooseRoute, engineForChain, forcedEngine, routeForBot, type AutoRouteConfig, type BotRoute } from "./auto-route.ts";

const claude = { instanceId: "claude", model: "claude-sonnet-5" };
const codex = { instanceId: "codex", model: "gpt-6-luna" };
const acp = { instanceId: "orq-acp", model: "agent-default" };
const config: BotRoute = {
  url: "http://router.test/v1/clasificar",
  tokenEnv: "ROUTER_TOKEN",
  engines: { claude, chatgpt: codex, "*": acp },
  aliases: { claude: "claude", gpt: "chatgpt", codex: "chatgpt" },
};
const remoteClaude = { instanceId: "claude-remote", model: "claude-sonnet-5" };
const remoteAcp = { instanceId: "remote", model: "agent-default" };
const full: AutoRouteConfig = {
  ...config,
  bots: { Auto: "local", Studio: "remote", Infra: "remote" },
  engines: { local: config.engines, remote: { claude: remoteClaude, "*": remoteAcp } },
};
const answering = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe("routeForBot", () => {
  it("gives each bot only its own engine set", () => {
    expect(routeForBot(full, "Auto")?.engines).toBe(config.engines);
    const studio = routeForBot(full, "Studio")!;
    expect(studio).toMatchObject({ url: config.url, tokenEnv: "ROUTER_TOKEN", engines: full.engines.remote });
    expect(engineForChain(["chatgpt/gpt"], studio, () => false)?.selection).toBe(remoteAcp);
    expect(forcedEngine("@claude hi", studio)).toEqual({ key: "claude", text: "hi" });
    expect(forcedEngine("@gpt hi", studio)).toBeNull();
  });
  it("leaves other bots alone", () => {
    expect(routeForBot(full, "Codex")).toBeNull();
    expect(routeForBot(full, "toString")).toBeNull();
    expect(routeForBot(undefined, "Auto")).toBeNull();
  });
});

describe("forcedEngine", () => {
  it("takes a leading alias and strips it", () => {
    expect(forcedEngine("  @GPT fix the parser", config)).toEqual({ key: "chatgpt", text: "fix the parser" });
  });
  it("ignores unknown aliases and mentions mid-text", () => {
    expect(forcedEngine("@nobody hi", config)).toBeNull();
    expect(forcedEngine("ask @claude later", config)).toBeNull();
  });
});

describe("engineForChain", () => {
  it("maps providers, falls back to *, and skips blocked engines", () => {
    expect(engineForChain(["claude/sonnet", "groq/x"], config, () => false)).toEqual({ entry: "claude/sonnet", selection: claude });
    expect(engineForChain(["groq/x"], config, () => false)).toEqual({ entry: "groq/x", selection: acp });
    expect(engineForChain(["claude/sonnet", "chatgpt/gpt"], config, (id) => id === "claude")?.selection).toBe(codex);
  });
  it("skips unmapped providers when there is no *", () => {
    expect(engineForChain(["groq/x"], { ...config, engines: { claude } }, () => false)).toBeNull();
  });
});

describe("chooseRoute", () => {
  it("forces without asking the classifier", async () => {
    const fetch = answering({});
    expect(await chooseRoute("@claude hi", config, { pinned: false, blocked: () => false, fetch })).toEqual({ selection: claude, text: "hi", why: "@claude", pin: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps pinned turns without asking the classifier", async () => {
    const fetch = answering({});
    expect(await chooseRoute("hi", config, { pinned: true, blocked: () => false, fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await chooseRoute("@gpt hi", config, { pinned: true, blocked: () => false, fetch }))
      .toEqual({ selection: codex, text: "hi", why: "@chatgpt", pin: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reserves @auto and classifies the same turn", async () => {
    const fetch = answering({ cadena: ["claude/sonnet"] });
    expect(await chooseRoute("@AUTO hi", { ...config, aliases: { auto: "chatgpt" } },
      { pinned: true, blocked: () => false, fetch }))
      .toEqual({ selection: claude, text: "hi", why: "claude/sonnet", pin: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).messages).toEqual([{ role: "user", content: "hi" }]);
  });
  it("unpins even when classification fails or a route stays put", async () => {
    for (const fetch of [answering({}, 503), answering({ ruta: "stay" })]) {
      expect(await chooseRoute("@auto hi", { ...config, rutas: { stay: null } },
        { pinned: true, blocked: () => false, fetch })).toEqual({ text: "hi", why: "", pin: false });
    }
  });
  it("prefers listed routes over the provider chain", async () => {
    const fetch = answering({ ruta: "code", cadena: ["claude/sonnet"], motivo: "coding" });
    expect(await chooseRoute("hi", { ...config, rutas: { code: "chatgpt" } },
      { pinned: false, blocked: () => false, fetch }))
      .toEqual({ selection: codex, text: "hi", why: "code→chatgpt · coding" });
  });
  it("stays for null, missing or blocked table engines", async () => {
    for (const key of [null, "missing", "chatgpt"]) {
      expect(await chooseRoute("hi", { ...config, rutas: { code: key } },
        { pinned: false, blocked: (id) => id === "codex", fetch: answering({ ruta: "code", cadena: ["claude/sonnet"] }) })).toBeNull();
    }
  });
  it("uses the chain for an unlisted route", async () => {
    expect((await chooseRoute("hi", { ...config, rutas: { other: null } },
      { pinned: false, blocked: () => false, fetch: answering({ ruta: "code", cadena: ["claude/sonnet"] }) }))?.selection).toBe(claude);
  });
  it("sends at most four truncated history messages and the current text", async () => {
    const fetch = answering({ cadena: ["claude/sonnet"] });
    const history = ["old", "a".repeat(600), { role: "assistant" as const, content: "b".repeat(600) }, "third", "fourth"];
    await chooseRoute("x".repeat(2500), config, { pinned: false, blocked: () => false, fetch, history });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).messages).toEqual([
      { role: "user", content: "a".repeat(500) },
      { role: "assistant", content: "b".repeat(500) },
      { role: "user", content: "third" },
      { role: "user", content: "fourth" },
      { role: "user", content: "x".repeat(2000) },
    ]);
  });
  it("sends the token and follows the chain", async () => {
    const fetch = answering({ cadena: ["chatgpt/gpt-6-luna", "claude/sonnet"], ruta: "implementar", nivel: "alta", motivo: "codigo/alta" });
    const route = await chooseRoute("write a parser", config, { pinned: false, blocked: () => false, fetch, env: { ROUTER_TOKEN: "t" } });
    expect(route).toEqual({ selection: codex, text: "write a parser", why: "chatgpt/gpt-6-luna · codigo/alta" });
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { authorization: "Bearer t" } });
  });
  it("names the route and level when there is no reason", async () => {
    const fetch = answering({ cadena: ["groq/llama"], ruta: "charla", nivel: "baja" });
    expect((await chooseRoute("hi", config, { pinned: false, blocked: () => false, fetch }))?.why).toBe("groq/llama · charla/baja");
  });
  it("leaves the thread alone when the classifier fails", async () => {
    expect(await chooseRoute("hi", config, { pinned: false, blocked: () => false, fetch: answering({}, 503) })).toBeNull();
    expect(await chooseRoute("hi", config, { pinned: false, blocked: () => false, fetch: vi.fn(async () => { throw new Error("down"); }) })).toBeNull();
    expect(await chooseRoute("hi", config, { pinned: false, blocked: () => true, fetch: answering({ cadena: ["claude/sonnet"] }) })).toBeNull();
  });
});
