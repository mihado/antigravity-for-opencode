import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AgyPlugin from "../src/index";
import { setupV2Plugin } from "../src/agy-v2";
import { AgyError, projectPolicy, runAgy, scrubSecrets } from "../src/agy-runner";

let root: string;
let outside: string;

beforeAll(async () => {
  root = realpathSync(await mkdtemp(path.join(tmpdir(), "agy-root-")));
  outside = realpathSync(await mkdtemp(path.join(tmpdir(), "agy-outside-")));
  await mkdir(path.join(root, "sub"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** A child that finishes immediately with the given output. */
function finishedSpawn(stdout: string, exitCode = 0) {
  const calls: Array<{ argv: string[]; opts: any }> = [];
  const bytes = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (text) c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
  const spawnFn: any = (argv: string[], opts: any) => {
    calls.push({ argv, opts });
    return { stdin: { end() {} }, stdout: bytes(stdout), stderr: bytes(""), exited: Promise.resolve(exitCode), kill() {} };
  };
  return { spawnFn, calls };
}

/** A child that runs until killed, then exits with `exitOnKill` (143 = SIGTERM). */
function killableSpawn(exitOnKill: number) {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  const closers: Array<() => void> = [];
  const open = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        closers.push(() => c.close());
      },
    });
  const proc = {
    stdin: { end() {} },
    stdout: open(),
    stderr: open(),
    exited,
    kill() {
      closers.forEach((close) => close());
      resolveExit(exitOnKill);
    },
  };
  return { spawnFn: (() => proc) as any };
}

describe("project root policy", () => {
  test("projectPolicy ignores a missing or non-string directory", () => {
    expect(projectPolicy(undefined)).toBeUndefined();
    expect(projectPolicy("")).toBeUndefined();
    expect(projectPolicy(42)).toBeUndefined();
  });

  test("projectPolicy roots at the host directory, and AGY_WORKSPACE_ROOT still wins", () => {
    const prev = process.env.AGY_WORKSPACE_ROOT;
    try {
      delete process.env.AGY_WORKSPACE_ROOT;
      expect(projectPolicy(root)).toEqual({ workspaceRoot: root });
      process.env.AGY_WORKSPACE_ROOT = outside;
      expect(projectPolicy(root)).toEqual({ workspaceRoot: outside });
    } finally {
      if (prev === undefined) delete process.env.AGY_WORKSPACE_ROOT;
      else process.env.AGY_WORKSPACE_ROOT = prev;
    }
  });

  test("the child runs in the project directory and a dir inside it is granted", async () => {
    const prev = process.env.AGY_WORKSPACE_ROOT;
    delete process.env.AGY_WORKSPACE_ROOT;
    try {
      const { spawnFn, calls } = finishedSpawn("ok");
      await runAgy({ prompt: "x", dir: path.join(root, "sub"), policy: projectPolicy(root) }, spawnFn);
      expect(calls[0]!.opts.cwd).toBe(path.join(root, "sub"));
      await runAgy({ prompt: "x", policy: projectPolicy(root) }, spawnFn);
      expect(calls[1]!.opts.cwd).toBe(root);
    } finally {
      if (prev !== undefined) process.env.AGY_WORKSPACE_ROOT = prev;
    }
  });

  test("v2 setup confines dir to ctx.location.directory, not the process cwd", async () => {
    const prev = process.env.AGY_WORKSPACE_ROOT;
    delete process.env.AGY_WORKSPACE_ROOT;
    try {
      const tools = new Map<string, any>();
      await setupV2Plugin({
        location: { directory: root },
        tool: { transform: (fn: any) => fn({ add: (d: any) => tools.set(d.name, d), has: tools.has.bind(tools) }) },
      });
      const out = await tools.get("agy").execute({ prompt: "x", dir: outside });
      expect(out.metadata.code).toBe("DIR_NOT_ALLOWED");
      expect(out.metadata.details.workspaceRoot).toBe(root);
    } finally {
      if (prev !== undefined) process.env.AGY_WORKSPACE_ROOT = prev;
    }
  });

  test("v1 server confines dir to ctx.directory, not the process cwd", async () => {
    const prev = process.env.AGY_WORKSPACE_ROOT;
    delete process.env.AGY_WORKSPACE_ROOT;
    try {
      const hooks: any = await AgyPlugin.server({ directory: root } as any);
      const out = await hooks.tool.agy.execute({ prompt: "x", dir: outside }, {});
      expect(out.metadata.code).toBe("DIR_NOT_ALLOWED");
      expect(out.metadata.details.workspaceRoot).toBe(root);
    } finally {
      if (prev !== undefined) process.env.AGY_WORKSPACE_ROOT = prev;
    }
  });
});

describe("cancellation", () => {
  test("aborting a running child reports CANCELLED, not TIMEOUT", async () => {
    const { spawnFn } = killableSpawn(143);
    const ac = new AbortController();
    const pending = runAgy({ prompt: "x", policy: { workspaceRoot: root }, signal: ac.signal }, spawnFn);
    setTimeout(() => ac.abort(), 20);
    const err = (await pending.catch((e) => e)) as AgyError;
    expect(err).toBeInstanceOf(AgyError);
    expect(err.code).toBe("CANCELLED");
    expect(err.details?.suggestedNextTimeout).toBeUndefined();
  });

  test("a signal that is already aborted reports CANCELLED", async () => {
    const { spawnFn } = killableSpawn(143);
    const ac = new AbortController();
    ac.abort();
    const err = (await runAgy({ prompt: "x", policy: { workspaceRoot: root }, signal: ac.signal }, spawnFn).catch(
      (e) => e
    )) as AgyError;
    expect(err.code).toBe("CANCELLED");
  });

  test("a SIGTERM exit nobody asked for is still classified as TIMEOUT", async () => {
    const { spawnFn } = finishedSpawn("", 143);
    const err = (await runAgy({ prompt: "x", policy: { workspaceRoot: root } }, spawnFn).catch((e) => e)) as AgyError;
    expect(err.code).toBe("TIMEOUT");
  });
});

describe("scrubber leaves code alone, still redacts values", () => {
  test.each([
    ["interface Auth { token: string; password: string }"],
    ["def f(api_key: str) -> None:"],
    ["const secret = process.env.SECRET_KEY;"],
    ["headers: Record<string, string>; token: Optional[str] = None"],
    ["const token = import.meta.env.VITE_TOKEN"],
    ['api_key = os.environ["API_KEY"]'],
  ])("keeps %s", (code) => {
    expect(scrubSecrets(code)).toBe(code);
  });

  test.each([
    ["FOO_SECRET=bar", "bar"],
    ["password: hunter2", "hunter2"],
    ["password=foo", "foo"],
    ['token: "string"', "string"],
    ["api_key = abc123def456", "abc123def456"],
    ['{"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG"}', "wJalrXUtnFEMI"],
  ])("still redacts %s", (text, secret) => {
    const out = scrubSecrets(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret);
  });
});
