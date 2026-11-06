// Bring-your-own engine: any agent CLI speaking ACP over stdio, from one config entry:
//   { "instances": { "my-agent": {
//       "driver": "customAcp",
//       "displayName": "My Agent",
//       "config": { "cli": "my-agent acp" } } } }
// `cli` is the whole command ("npx -y some-agent acp" works). No auth step: the CLI is signed in from
// a terminal. Model selection uses ACP, never -m on argv, since conventions differ per CLI.
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { resolveCustomAcpModels } from "./custom-model-catalog.ts";

const CONFIGURE_HINT =
  'a custom ACP engine needs its command — add "config": { "cli": "<your-agent> acp" } to this instance in config.json, or use Settings → Engines → Set CLI…';

const support: AcpSupport = {
  driverKind: "customAcp",
  displayName: "Custom (ACP)",
  access: "custom",
  models: { default: "agent-default", options: [{ id: "agent-default", label: "Agent default", custom: true }] },
  defaultCli: "",
  nativeSource: "custom.acp",
  loginNote: CONFIGURE_HINT,
  spawnArgs: () => [],
  resolveModels: resolveCustomAcpModels,
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: "agent-default", allowLegacy: true },
  modelVariants: true,
  phoneMcp: true,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  sessionScopedApproval: true,
  configureSession: configureCustomMode,
};

/** Values of a `mode` select option, flattening grouped options. */
function modeValues(option: any): string[] {
  const flat = (list: any[]): string[] => list.flatMap((o) => (Array.isArray(o?.options) ? flat(o.options) : typeof o?.value === "string" ? [o.value] : []));
  return Array.isArray(option?.options) ? flat(option.options) : [];
}

/** Engines offering a `mode` option with `auto_edit` (Antigravity/Gemini) get the edits level; others (Codex ACP) are left alone. */
export async function configureCustomMode(
  { request, sessionId, turn, configOptions }: Parameters<NonNullable<AcpSupport["configureSession"]>>[0],
): Promise<void> {
  const option: any = configOptions.find((o) => o?.id === "mode");
  const values = modeValues(option);
  if (!values.includes("auto_edit")) return;
  const wanted = turn.approvalMode === "edits" ? "auto_edit" : values.includes("default") ? "default" : values.find((v) => v !== "auto_edit");
  if (!wanted || option.currentValue === wanted) return;
  await request("session/set_config_option", { sessionId, configId: "mode", value: wanted });
}

const base = createAcpDriver(support);

export const CustomAcpDriver: typeof base = {
  ...base,
  decodeConfig(raw) {
    const decoded = base.decodeConfig(raw);
    if (!decoded.cli.trim()) throw new Error(CONFIGURE_HINT);
    return decoded;
  },
  async create(input) {
    if (!input.config.cli.trim()) throw new Error(CONFIGURE_HINT);
    // What the person reads names their agent ("My Agent"), never "Custom (ACP)".
    const name = input.displayName?.trim();
    return (name ? createAcpDriver({ ...support, displayName: name }) : base).create(input);
  },
};
