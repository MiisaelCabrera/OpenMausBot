// `!command` in a chat: a typed line starting with "!" runs as a shell command in the thread's folder and the
// output lands in the thread, without a model turn (as in Claude Code). Only a present person may use it: the
// route refuses it for a bot's own loopback calls, so a bot cannot lift its approval level by messaging itself.
// Engines that live on another machine are reached through OMB_BANG_REMOTE, an executable called as
// `<remote> <cwd>` with the command on stdin; it applies to instances whose id ends with OMB_BANG_REMOTE_SUFFIX
// (default "-monstruo").
import { spawn } from "node:child_process";

const TIMEOUT_MS = 120_000;
const MAX_BYTES = 20_000;

/** The command a "!…" message carries, or null when it is not one ("!" alone and "!!" stay ordinary text). */
export function bangCommand(text: string): string | null {
  const m = /^!(?!!)\s*([\s\S]+)$/.exec(text.trim());
  return m && m[1].trim() ? m[1].trim() : null;
}

/** The remote runner for this engine instance, or null to run in this process's machine. */
export function bangRemote(instanceId: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const remote = env.OMB_BANG_REMOTE?.trim();
  const suffix = env.OMB_BANG_REMOTE_SUFFIX?.trim() || "-monstruo";
  return remote && instanceId?.endsWith(suffix) ? remote : null;
}

export interface BangResult { output: string; code: number | null; timedOut: boolean; truncated: boolean }

export function runBang(
  command: string,
  cwd: string,
  remote: string | null,
  { timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES }: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<BangResult> {
  return new Promise((resolve) => {
    const child = remote
      ? spawn(remote, [cwd], { stdio: ["pipe", "pipe", "pipe"], detached: true })
      : spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (remote) child.stdin!.end(command);
    let output = "";
    let truncated = false;
    let timedOut = false;
    const take = (chunk: Buffer) => {
      if (output.length >= maxBytes) { truncated = true; return; }
      output += chunk.toString("utf8");
      if (output.length > maxBytes) { output = output.slice(0, maxBytes); truncated = true; }
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ output: output + String(error.message), code: null, timedOut, truncated }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ output, code, timedOut, truncated }); });
  });
}

/** The chat line for a finished command. */
export function bangReply(command: string, result: BangResult): string {
  const body = result.output.replace(/\s+$/u, "");
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const status = result.timedOut ? "⏱ cortado por tiempo" : result.code === 0 ? "" : `salió con código ${result.code ?? "?"}`;
  const notes = [status, result.truncated ? "salida recortada" : ""].filter(Boolean).join(" · ");
  return `${fence}\n$ ${command}\n${body ? `${body}\n` : ""}${fence}${notes ? `\n_${notes}_` : ""}`;
}
