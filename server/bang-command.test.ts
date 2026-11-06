import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bangCommand, bangRemote, bangReply, runBang } from "./bang-command.ts";

describe("bang commands", () => {
  it("reads only a single leading bang", () => {
    expect(bangCommand("!ls -la")).toBe("ls -la");
    expect(bangCommand("  ! git status ")).toBe("git status");
    expect(bangCommand("!")).toBeNull();
    expect(bangCommand("!!")).toBeNull();
    expect(bangCommand("!!ls")).toBeNull();
    expect(bangCommand("hola !ls")).toBeNull();
  });

  it("picks the remote runner only for matching instances", () => {
    const env = { OMB_BANG_REMOTE: "/bin/omb-sh" };
    expect(bangRemote("claude-monstruo", env)).toBe("/bin/omb-sh");
    expect(bangRemote("codex", env)).toBeNull();
    expect(bangRemote(undefined, env)).toBeNull();
    expect(bangRemote("claude-monstruo", {})).toBeNull();
    expect(bangRemote("x-lab", { ...env, OMB_BANG_REMOTE_SUFFIX: "-lab" })).toBe("/bin/omb-sh");
  });

  it("runs in the folder and reports output and exit code", async () => {
    const ok = await runBang("pwd; echo err >&2", "/tmp", null);
    expect(ok).toMatchObject({ code: 0, timedOut: false, truncated: false });
    expect(ok.output).toContain("/tmp");
    expect(ok.output).toContain("err");
    expect(await runBang("exit 3", "/tmp", null)).toMatchObject({ code: 3 });
  });

  it("cuts a command that runs too long and trims huge output", async () => {
    expect(await runBang("sleep 5", "/tmp", null, { timeoutMs: 100 })).toMatchObject({ timedOut: true });
    const big = await runBang("head -c 5000 /dev/zero | tr '\\0' x", "/tmp", null, { maxBytes: 100 });
    expect(big.truncated).toBe(true);
    expect(big.output.length).toBe(100);
  });

  it("passes the command to a remote runner on stdin with the folder as argument", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bang-"));
    const script = join(dir, "remote.sh");
    writeFileSync(script, "#!/bin/sh\necho \"cwd=$1\"; cat\n");
    chmodSync(script, 0o755);
    try {
      expect((await runBang("echo hola", "/x", script)).output).toBe("cwd=/x\necho hola");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats the reply with a safe fence and notes", () => {
    expect(bangReply("ls", { output: "a\nb\n", code: 0, timedOut: false, truncated: false })).toBe("```\n$ ls\na\nb\n```");
    expect(bangReply("x", { output: "```y```", code: 1, timedOut: false, truncated: true })).toContain("````\n$ x");
    expect(bangReply("x", { output: "", code: 1, timedOut: false, truncated: true })).toContain("_salió con código 1 · salida recortada_");
    expect(bangReply("x", { output: "", code: null, timedOut: true, truncated: false })).toContain("cortado por tiempo");
  });
});
