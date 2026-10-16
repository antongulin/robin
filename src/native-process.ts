import { ChildProcess, spawn } from "child_process";

// Internal test seam; these are fixed production limits, never action/env inputs.
export const nativeProcessLimits = {
  timeoutMs: 120_000, maxOutput: 32 * 1024 * 1024,
  shutdownMs: 5000, probeMs: 1000,
};

export class NativeProcessLifecycleError extends Error {
  constructor() { super("NATIVE_DIFF_LIFECYCLE_FAILED"); }
}

function validPid(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && pid! > 1;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ESRCH";
}

// kill(0) includes zombies. Only a bounded, validated process-state snapshot can
// distinguish those from live descendants that may still use the object store.
function probeGroup(group: number): { result: Promise<boolean>; cancel: () => void } {
  let cancel = () => {};
  const result = new Promise<boolean>(resolve => {
    let probe: ChildProcess;
    try {
      probe = spawn("ps", ["-A", "-o", "pgid=", "-o", "stat="], {
        env: { PATH: process.env.PATH, LC_ALL: "C" }, shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { resolve(false); return; }
    let done = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (stopped: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(stopped);
    };
    cancel = () => {
      if (done) return;
      // kill/destroy can synchronously emit error and reenter cancellation.
      finish(false);
      if (validPid(probe.pid)) { try { probe.kill("SIGKILL"); } catch { /* unknown; fail closed */ } }
      probe.stdout?.destroy();
    };
    const timer = setTimeout(() => cancel(), nativeProcessLimits.probeMs);
    probe.on("error", cancel);
    probe.stdout?.on("error", cancel);
    probe.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) cancel();
      else chunks.push(chunk);
    });
    probe.on("close", code => {
      if (done) return;
      if (code !== 0 || size === 0) { finish(false); return; }
      const rows = Buffer.concat(chunks).toString("ascii").trim().split("\n");
      let live = false;
      let seen = false;
      for (const row of rows) {
        const match = /^\s*(\d+)\s+([A-Za-z][A-Za-z0-9+<>=-]*)\s*$/.exec(row);
        if (!match || !Number.isSafeInteger(Number(match[1]))) { finish(false); return; }
        if (Number(match[1]) === group) {
          seen = true;
          if (!match[2].startsWith("Z")) live = true;
        }
      }
      if (seen) { finish(!live); return; }
      // An omitted group is insufficient if kill(0) still sees it (e.g. a
      // restricted ps). Confirm absence rather than assuming visibility.
      try { process.kill(-group, 0); finish(false); }
      catch (error) { finish(missing(error)); }
    });
    if (!probe.stdout) cancel();
  });
  return { result, cancel: () => cancel() };
}

/** Run Git in one owned POSIX group. Never expose child errors or partial output. */
export function runNativeGit(args: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("git", args, { env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch { reject(new Error("NATIVE_DIFF_COMMAND_FAILED")); return; }
    const group = child.pid;
    let closed = false;
    let confirmed = group === undefined;
    let stopping = false;
    let settled = false;
    let failure: Error | undefined;
    let shutdown: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let probe: ReturnType<typeof probeGroup> | undefined;
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(shutdown);
      clearTimeout(poll);
      probe?.cancel();
      if (error) reject(error);
      else resolve(Buffer.concat(stdout, stdoutSize));
    };
    const settle = () => { if (closed && confirmed) finish(failure); };
    const check = async () => {
      if (settled || !validPid(group)) return;
      try { process.kill(-group, 0); }
      catch (error) {
        if (missing(error)) { confirmed = true; settle(); return; }
        // Permission/observation failures cannot establish shutdown.
        poll = setTimeout(() => { void check(); }, 25);
        return;
      }
      probe = probeGroup(group);
      const stopped = await probe.result;
      probe = undefined;
      if (settled) return;
      if (stopped) { confirmed = true; settle(); }
      else poll = setTimeout(() => { void check(); }, 25);
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(deadline);
      shutdown = setTimeout(() => finish(new NativeProcessLifecycleError()), nativeProcessLimits.shutdownMs);
      if (validPid(group)) {
        try { process.kill(-group, "SIGKILL"); }
        catch (error) {
          if (missing(error)) confirmed = true;
          else failure ||= new Error("NATIVE_DIFF_COMMAND_FAILED");
        }
        void check();
      } else if (group !== undefined) {
        failure = new NativeProcessLifecycleError();
        // No safe group target; preserve storage on the bounded failure path.
      }
      settle();
    };
    const fail = (code: string) => { failure ||= new Error(code); stop(); };
    const deadline = setTimeout(() => fail("NATIVE_DIFF_CHILD_TERMINATED"), nativeProcessLimits.timeoutMs);
    child.on("error", () => fail("NATIVE_DIFF_COMMAND_FAILED"));
    child.stdout?.on("error", () => fail("NATIVE_DIFF_COMMAND_FAILED"));
    child.stderr?.on("error", () => fail("NATIVE_DIFF_COMMAND_FAILED"));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure || settled) return;
      stdoutSize += chunk.length;
      if (stdoutSize > nativeProcessLimits.maxOutput) fail("NATIVE_DIFF_OUTPUT_LIMIT");
      else stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (failure || settled) return;
      stderrSize += chunk.length;
      if (stderrSize > nativeProcessLimits.maxOutput) fail("NATIVE_DIFF_OUTPUT_LIMIT");
    });
    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) failure ||= new Error("NATIVE_DIFF_COMMAND_FAILED");
      stop(); // A successful leader can leave helpers with closed or inherited pipes.
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (code !== 0 || signal) failure ||= new Error("NATIVE_DIFF_COMMAND_FAILED");
      stop();
      settle();
    });
    if (!child.stdout || !child.stderr) fail("NATIVE_DIFF_COMMAND_FAILED");
  });
}
