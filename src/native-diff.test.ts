import childProcess = require("child_process");
import fs = require("fs/promises");
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nativePullRequestDiff } from "./native-diff";
import { createServer, Socket, AddressInfo } from "net";
import { nativeProcessLimits, runNativeGit } from "./native-process";

jest.setTimeout(20_000);
const realSpawn = childProcess.spawn;
const realProcessKill = process.kill;
const realRm = fs.rm;
const fixture = join(__dirname, "../testdata/native-process.cjs");
const snapshot = { base: "a".repeat(40), head: "b".repeat(40), files: 1 };
let control: string;
let storage: string[];
let children: { child: childProcess.ChildProcess; closed: boolean; detached: boolean; stdoutBytes: number; stderrBytes: number }[];
let sentinel: childProcess.ChildProcess;
let sentinelClosed: boolean;

// Even a regression in the safety guard must not signal the test runner or
// another task. The sentinel also detects accidental signals within owned work.
function fixtureKill(pid: number, signal?: number | string): true {
  if (!children.some(record => record.detached && record.child.pid! > 1 && pid === -record.child.pid!)) {
    throw new Error("Unexpected process-group target");
  }
  return realProcessKill(pid, signal);
}
function processes() {
  return childProcess.execFileSync("ps", ["-e", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="], {
    encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024,
  }).trim().split("\n").map(line => {
    const [pid, ppid, pgid, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state };
  });
}
function ownedPids(): number[] {
  return ["leader", "branch", "leaf"].filter(role => existsSync(join(control, `${role}.pid`)))
    .map(role => Number(readFileSync(join(control, `${role}.pid`), "utf8")));
}
function liveOwned(): number[] {
  const pids = ownedPids();
  return processes().filter(row => pids.includes(row.pid) && !row.state.startsWith("Z")).map(row => row.pid);
}
async function until(condition: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Fixture condition timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function track(child: childProcess.ChildProcess, detached: boolean) {
  const record = { child, closed: false, detached, stdoutBytes: 0, stderrBytes: 0 };
  children.push(record);
  child.stdout?.on("data", (chunk: Buffer) => { record.stdoutBytes += chunk.length; });
  child.stderr?.on("data", (chunk: Buffer) => { record.stderrBytes += chunk.length; });
  child.once("close", () => { record.closed = true; });
  return child;
}
function acquire() {
  const verify = jest.fn().mockResolvedValue(undefined);
  const result = nativePullRequestDiff("fixture", "repository", "synthetic-token", snapshot, verify)
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
  return { result, verify };
}
function observeRemoval() {
  const observations: { closed: boolean; live: number[] }[] = [];
  jest.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    observations.push({ closed: children.every(record => record.closed), live: liveOwned() });
    return realRm(path, options);
  });
  return observations;
}

beforeEach(async () => {
  control = mkdtempSync(join(tmpdir(), "robin-process-fixture-"));
  storage = []; children = [];
  jest.replaceProperty(nativeProcessLimits, "timeoutMs", 1000);
  sentinelClosed = false;
  sentinel = realSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  sentinel.once("close", () => { sentinelClosed = true; });
  await new Promise<void>(resolve => sentinel.once("spawn", resolve));
  jest.spyOn(process, "kill").mockImplementation(fixtureKill);
});
afterEach(async () => {
  // Guardians run after test assertions, and only touch captured fixture resources.
  jest.restoreAllMocks();
  for (const { child, detached } of children) {
    if (child.pid && child.pid > 1) { try { process.kill(detached ? -child.pid : child.pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  for (const pid of ownedPids()) if (Number.isSafeInteger(pid) && pid > 1) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  sentinel.kill("SIGKILL");
  await until(() => liveOwned().length === 0 && children.every(record => record.closed) && sentinelClosed, "guardian shutdown");
  for (const directory of storage) rmSync(directory, { recursive: true, force: true });
  rmSync(control, { recursive: true, force: true });
});

function installFixture(options: Record<string, unknown>) {
  return jest.spyOn(childProcess, "spawn").mockImplementation(((file: string, args: string[], opts: any) => {
    if (file !== "git") return realSpawn(file, args, opts);
    if (args.includes("init")) storage.push(args[args.length - 1]);
    expect(opts.detached).toBe(true); expect(opts.shell).toBe(false);
    return track(realSpawn(process.execPath, [fixture, "leader", control, JSON.stringify(options), ...args], opts), true);
  }) as any);
}
async function ready() {
  await until(() => existsSync(join(control, "ready")), "descendants ready");
  writeFileSync(join(control, "go"), "go");
}
function command() {
  return runNativeGit(["fixture-command"], { PATH: process.env.PATH })
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
}
function cleanFailure(outcome: { value: unknown; error: Error | undefined }, code: string) {
  expect(outcome.error?.message).toBe(code);
  expect(outcome.error?.cause).toBeUndefined();
  expect(outcome.value).toBeUndefined();
  expect(liveOwned()).toEqual([]);
  expect(children.every(record => record.closed)).toBe(true);
}
function sentinelAlive() {
  expect(processes().some(row => row.pid === sentinel.pid && !row.state.startsWith("Z"))).toBe(true);
}
const encoded = (value: string | Buffer) => Buffer.from(value).toString("base64");

test.each([false, true])("N1: timeout stops child/grandchild before removal (closed stdio=%s)", async closed => {
  installFixture({ closed, stdout: encoded("partial patch") });
  const removals = observeRemoval();
  const { result, verify } = acquire();
  await ready();
  expect(ownedPids()).toHaveLength(3);
  const outcome = await result;
  cleanFailure(outcome, "NATIVE_DIFF_CHILD_TERMINATED");
  expect(verify).not.toHaveBeenCalled();
  expect(removals).toEqual([{ closed: true, live: [] }]);
  expect(storage.every(directory => !existsSync(directory))).toBe(true);
  sentinelAlive();
});

test.each(["stdout", "stderr"])("N2: %s byte overflow across UTF-8 chunks kills descendants before removal", async stream => {
  jest.replaceProperty(nativeProcessLimits, "maxOutput", 256);
  installFixture({ stream, chunks: [encoded(Buffer.concat([Buffer.alloc(255, 97), Buffer.from([0xc3])])), encoded(Buffer.from([0xa9]))] });
  const removals = observeRemoval();
  const { result } = acquire();
  await ready();
  await until(() => children[0][stream === "stdout" ? "stdoutBytes" : "stderrBytes"] === 256, "first byte chunk consumed");
  expect(liveOwned()).toHaveLength(3);
  writeFileSync(join(control, "next-0"), "continue");
  cleanFailure(await result, "NATIVE_DIFF_OUTPUT_LIMIT");
  expect(removals).toEqual([{ closed: true, live: [] }]);
  sentinelAlive();
});

test.each(["stdout", "stderr"])("N2: actual default 32MiB %s overflow refuses a prefix", async flood => {
  jest.replaceProperty(nativeProcessLimits, "timeoutMs", 5000);
  // maxOutput deliberately retains the production value for both real floods.
  expect(nativeProcessLimits.maxOutput).toBe(32 * 1024 * 1024);
  installFixture({ flood, bytes: nativeProcessLimits.maxOutput + 1, stdout: encoded("valid-looking patch") });
  const removals = observeRemoval();
  const { result } = acquire();
  await ready();
  cleanFailure(await result, "NATIVE_DIFF_OUTPUT_LIMIT");
  expect(removals).toEqual([{ closed: true, live: [] }]);
  sentinelAlive();
});

test("N2: exact independent byte limits on both streams succeed without an aggregate cap", async () => {
  const output = Buffer.concat([Buffer.alloc(62, 97), Buffer.from("é")]);
  jest.replaceProperty(nativeProcessLimits, "maxOutput", output.length);
  installFixture({ descendants: false, stdout: encoded(output), stderr: encoded(output), exit: 0 });
  const result = command();
  await ready();
  const outcome = await result;
  expect(outcome.error).toBeUndefined(); expect(outcome.value).toEqual(output);
  expect(children[0].stderrBytes).toBe(output.length);
  expect(children[0].closed).toBe(true);
  sentinelAlive();
});

test("N3: real Git HTTPS helpers and socket stop before removal while loopback server stays open", async () => {
  const sockets: Socket[] = [];
  let received = 0;
  const server = createServer(socket => {
    sockets.push(socket); socket.on("data", data => { received += data.length; }); socket.on("error", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const saved = process.env.GITHUB_SERVER_URL;
  process.env.GITHUB_SERVER_URL = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  jest.replaceProperty(nativeProcessLimits, "timeoutMs", 1500);
  const helperPids: number[] = [];
  const removal: { closed: boolean; live: number[]; socketsClosed: boolean }[] = [];
  jest.spyOn(childProcess, "spawn").mockImplementation(((file: string, args: string[], opts: any) => {
    if (file === "git") {
      if (args.includes("init")) storage.push(args[args.length - 1]);
      if (args.includes("fetch")) expect(args[args.indexOf("--") + 1]).toBe(`${process.env.GITHUB_SERVER_URL}/fixture/repository.git`);
      return track(realSpawn(file, args, opts), true);
    }
    return realSpawn(file, args, opts);
  }) as any);
  jest.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    removal.push({ closed: children.every(record => record.closed),
      live: processes().filter(row => helperPids.includes(row.pid) && !row.state.startsWith("Z")).map(row => row.pid),
      socketsClosed: sockets.length > 0 && sockets.every(socket => socket.destroyed) });
    return realRm(path, options);
  });
  try {
    const { result, verify } = acquire();
    await until(() => received > 0 && children.length === 2, "Git TLS ClientHello", 5000);
    await until(() => {
      const group = children[1].child.pid;
      const helpers = processes().filter(row => row.pgid === group && row.pid !== group && !row.state.startsWith("Z"));
      helperPids.splice(0, helperPids.length, ...helpers.map(row => row.pid));
      return helperPids.length > 0;
    }, "actual Git nonleader helper");
    const outcome = await result;
    expect(outcome.error?.message).toBe("NATIVE_DIFF_CHILD_TERMINATED");
    expect(outcome.value).toBeUndefined(); expect(verify).not.toHaveBeenCalled();
    expect(removal).toEqual([{ closed: true, live: [], socketsClosed: true }]);
    expect(server.listening).toBe(true);
    expect(storage.every(directory => !existsSync(directory))).toBe(true);
    sentinelAlive();
    console.info("N3_GIT_EVIDENCE", JSON.stringify({ helpersObserved: helperPids.length, clientHelloBytes: received, removal }));
  } finally {
    // Recovery is after assertions; stopping the server cannot make the test pass.
    for (const { child } of children) if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (saved === undefined) delete process.env.GITHUB_SERVER_URL; else process.env.GITHUB_SERVER_URL = saved;
  }
});

test("N4: successful chunked binary/UTF-8 stdout is byte exact through child closure", async () => {
  const chunks = [Buffer.from([0, 255, 195]), Buffer.from([169, 13, 10, 0])];
  installFixture({ descendants: false, stream: "stdout", chunks: chunks.map(encoded), exit: 0 });
  const result = command();
  await ready();
  await until(() => children[0].stdoutBytes === chunks[0].length, "first exact output chunk");
  writeFileSync(join(control, "next-0"), "go");
  await until(() => children[0].stdoutBytes === chunks[0].length + chunks[1].length, "second exact output chunk");
  writeFileSync(join(control, "next-1"), "go");
  const outcome = await result;
  expect(outcome.error).toBeUndefined(); expect(outcome.value).toEqual(Buffer.concat(chunks));
  expect(children[0].closed).toBe(true); expect(liveOwned()).toEqual([]);
  sentinelAlive();
});

test.each([[0, false], [0, true], [7, false], [7, true]])("N4: leader exit %i stops surviving helpers (closed stdio=%s)", async (exit, closed) => {
  installFixture({ exit, closed, stdout: encoded("exact success bytes") });
  const result = command();
  await ready();
  expect(ownedPids()).toHaveLength(3);
  const outcome = await result;
  if (exit === 0) { expect(outcome.error).toBeUndefined(); expect(outcome.value).toEqual(Buffer.from("exact success bytes")); }
  else cleanFailure(outcome, "NATIVE_DIFF_COMMAND_FAILED");
  expect(liveOwned()).toEqual([]); expect(children[0].closed).toBe(true);
  sentinelAlive();
});

test.each(["ENOENT", "throw", "EMFILE"])("N5: %s spawn failure is sanitized without any group signal", async kind => {
  jest.spyOn(childProcess, "spawn").mockImplementation(((file: string, args: string[], opts: any) => {
    if (file !== "git") return realSpawn(file, args, opts);
    storage.push(args[args.length - 1]);
    if (kind === "throw") throw new Error("synthetic-token raw launch diagnostic");
    if (kind === "EMFILE") {
      // Node24 returns before setting up stdout/stderr on descriptor exhaustion.
      const child = new childProcess.ChildProcess();
      setImmediate(() => {
        child.emit("error", Object.assign(new Error("synthetic-token launch diagnostic"), { code: "EMFILE" }));
        child.emit("close", -1, null);
      });
      return track(child, false);
    }
    return track(realSpawn(join(control, "missing-executable"), [], opts), false);
  }) as any);
  const removals = observeRemoval();
  const kill = jest.spyOn(process, "kill");
  const { result, verify } = acquire();
  cleanFailure(await result, "NATIVE_DIFF_COMMAND_FAILED");
  expect(removals).toEqual([{ closed: true, live: [] }]);
  expect(kill).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  expect(children).toHaveLength(kind === "throw" ? 0 : 1);
  expect(storage.every(directory => !existsSync(directory))).toBe(true);
});

test("N5/N6: stream fault after partial bytes stays failed through a later zero exit", async () => {
  installFixture({ stdout: encoded("partial patch") });
  const removals = observeRemoval();
  const { result } = acquire();
  await ready();
  await until(() => children[0].stdoutBytes > 0, "partial bytes observed");
  children[0].child.stdout!.emit("error", new Error("synthetic-token read diagnostic"));
  children[0].child.emit("exit", 0, null);
  cleanFailure(await result, "NATIVE_DIFF_COMMAND_FAILED");
  expect(removals).toEqual([{ closed: true, live: [] }]);
  sentinelAlive();
});

test.each(["kill", "check"])("N6: owned-group %s EPERM is bounded and retains private storage when shutdown is unknown", async fault => {
  jest.replaceProperty(nativeProcessLimits, "shutdownMs", 250);
  installFixture({ stdout: encoded("prefix") });
  const remove = jest.spyOn(fs, "rm");
  const { result, verify } = acquire();
  await ready();
  const group = children[0].child.pid!;
  const realKill = fixtureKill;
  const kill = jest.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -group && signal === (fault === "kill" ? "SIGKILL" : 0)) {
      throw Object.assign(new Error("synthetic-token signal diagnostic"), { code: "EPERM" });
    }
    return realKill(pid, signal);
  });
  const started = Date.now();
  const outcome = await result;
  expect(Date.now() - started).toBeLessThan(4000);
  expect(outcome.error?.message).toBe("NATIVE_DIFF_LIFECYCLE_FAILED");
  expect(outcome.error?.cause).toBeUndefined(); expect(outcome.value).toBeUndefined();
  expect(remove).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  expect(storage).toHaveLength(1); expect(statSync(storage[0]).mode & 0o777).toBe(0o700);
  if (fault === "kill") { expect(liveOwned()).toHaveLength(3); expect(children[0].closed).toBe(false); }
  else { expect(liveOwned()).toEqual([]); expect(children[0].closed).toBe(true); }
  expect(kill.mock.calls.every(([pid]) => pid === -group)).toBe(true);
  sentinelAlive();
});

test("N6: a kill error stays failed when subsequent observation confirms natural shutdown", async () => {
  installFixture({ descendants: false, stdout: encoded("complete-looking output"), exit: 0 });
  const removals = observeRemoval();
  const realKill = fixtureKill;
  jest.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -children[0]?.child.pid! && signal === "SIGKILL") {
      throw Object.assign(new Error("synthetic-token kill diagnostic"), { code: "EPERM" });
    }
    return realKill(pid, signal);
  });
  const { result, verify } = acquire(); await ready();
  cleanFailure(await result, "NATIVE_DIFF_COMMAND_FAILED");
  expect(verify).not.toHaveBeenCalled();
  expect(children).toHaveLength(1); expect(removals).toEqual([{ closed: true, live: [] }]);
  sentinelAlive();
});

test("N6: natural ESRCH is benign and cleared deadlines cannot signal later work", async () => {
  installFixture({ descendants: false, stdout: encoded("complete"), exit: 0 });
  const timers = jest.spyOn(global, "setTimeout");
  const clears = jest.spyOn(global, "clearTimeout");
  const realKill = fixtureKill;
  const vanished: number[] = [];
  const kill = jest.spyOn(process, "kill").mockImplementation((pid, signal) => {
    try { return realKill(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") vanished.push(pid); throw error; }
  });
  const result = command(); await ready();
  const outcome = await result;
  expect(outcome.value).toEqual(Buffer.from("complete")); expect(outcome.error).toBeUndefined();
  expect(vanished).toContain(-children[0].child.pid!);
  const index = timers.mock.calls.findIndex(([, ms]) => ms === nativeProcessLimits.timeoutMs);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(clears).toHaveBeenCalledWith(timers.mock.results[index].value);
  const shutdown = timers.mock.calls.findIndex(([, ms]) => ms === nativeProcessLimits.shutdownMs);
  expect(shutdown).toBeGreaterThanOrEqual(0);
  expect(clears).toHaveBeenCalledWith(timers.mock.results[shutdown].value);
  const before = kill.mock.calls.length;
  (timers.mock.calls[index][0] as () => void)(); // A queued, cancelled timeout is harmless.
  expect(kill).toHaveBeenCalledTimes(before);
  expect(children[0].closed).toBe(true); sentinelAlive();
});

test.each(["malformed", "missing-group", "timeout", "overflow", "spawn-error", "resource-error"])("N6: bounded %s status probe cannot certify shutdown", async fault => {
  jest.replaceProperty(nativeProcessLimits, "shutdownMs", 1500);
  jest.replaceProperty(nativeProcessLimits, "probeMs", 500);
  const launch = installFixture({ descendants: false, exit: 0 });
  const fixtureSpawn = launch.getMockImplementation()!;
  const remove = jest.spyOn(fs, "rm");
  let group: number | undefined;
  const realKill = fixtureKill;
  jest.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (group && pid === -group) {
      if (signal === 0) return true; // Force the status-probe path after real closure.
      try { return realKill(pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    }
    return realKill(pid, signal);
  });
  const probes: childProcess.ChildProcess[] = [];
  launch.mockImplementation(((file: string, args: string[], options: any) => {
    if (file !== "ps") {
      const child = (fixtureSpawn as any)(file, args, options) as childProcess.ChildProcess;
      if (file === "git") group = child.pid;
      return child;
    }
    expect(args).toEqual(["-A", "-o", "pgid=", "-o", "stat="]);
    expect(Object.keys(options.env).sort()).toEqual(["LC_ALL", "PATH"]);
    const script = fault === "malformed" ? "process.stdout.write('unparseable synthetic-token')" :
      fault === "missing-group" ? "process.stdout.write('1 S\\n')" :
      fault === "overflow" ? "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 97))" : "setInterval(() => {}, 1000)";
    const child = fault === "resource-error" ? new childProcess.ChildProcess() :
      fault === "spawn-error" ? realSpawn(join(control, "missing-ps"), [], options) :
        realSpawn(process.execPath, ["-e", script], options);
    if (fault === "resource-error") setImmediate(() => {
      child.emit("error", Object.assign(new Error("synthetic-token probe diagnostic"), { code: "EMFILE" }));
      child.emit("close", -1, null);
    });
    probes.push(child); return track(child, false);
  }) as any);
  const { result } = acquire(); await ready();
  const outcome = await result;
  expect(outcome.error?.message).toBe("NATIVE_DIFF_LIFECYCLE_FAILED");
  expect(outcome.error?.cause).toBeUndefined(); expect(outcome.value).toBeUndefined();
  expect(remove).not.toHaveBeenCalled(); expect(existsSync(storage[0])).toBe(true);
  expect(probes.length).toBeGreaterThan(0);
  await until(() => children.every(record => record.closed), "probe cancellation closure");
  const observations = children.filter(record => probes.includes(record.child));
  if (fault === "overflow") expect(observations.some(record => record.stdoutBytes > 1024 * 1024)).toBe(true);
  if (fault === "malformed" || fault === "missing-group") expect(observations.some(record => record.stdoutBytes > 0)).toBe(true);
  if (fault === "timeout") expect(probes.some(child => child.signalCode === "SIGKILL")).toBe(true);
  if (fault === "spawn-error" || fault === "resource-error") expect(probes.every(child => child.pid === undefined)).toBe(true);
  const pids = probes.map(child => child.pid);
  expect(processes().filter(row => pids.includes(row.pid) && !row.state.startsWith("Z"))).toEqual([]);
  expect(liveOwned()).toEqual([]); sentinelAlive();
});

test("N6: missing child-close confirmation retains storage even after the OS process stops", async () => {
  jest.replaceProperty(nativeProcessLimits, "shutdownMs", 200);
  const launch = installFixture({ descendants: false, exit: 0 });
  const fixtureSpawn = launch.getMockImplementation()!;
  launch.mockImplementation(((file: string, args: string[], options: any) => {
    const child = (fixtureSpawn as any)(file, args, options) as childProcess.ChildProcess;
    if (file === "git") {
      const on = child.on.bind(child);
      jest.spyOn(child, "on").mockImplementation(((event: string, listener: (...args: any[]) => void) =>
        event === "close" ? child : on(event, listener)) as any);
    }
    return child;
  }) as any);
  const remove = jest.spyOn(fs, "rm");
  const { result } = acquire(); await ready();
  const outcome = await result;
  expect(outcome.error?.message).toBe("NATIVE_DIFF_LIFECYCLE_FAILED");
  expect(outcome.value).toBeUndefined(); expect(remove).not.toHaveBeenCalled();
  expect(liveOwned()).toEqual([]); expect(children[0].closed).toBe(true);
  expect(existsSync(storage[0])).toBe(true); sentinelAlive();
});

test.each([0, 1, -1])("N5: invalid captured PID %i never becomes a group signal", async invalid => {
  jest.replaceProperty(nativeProcessLimits, "shutdownMs", 200);
  const launch = installFixture({});
  const fixtureSpawn = launch.getMockImplementation()!;
  launch.mockImplementation(((file: string, args: string[], options: any) => {
    const child = (fixtureSpawn as any)(file, args, options) as childProcess.ChildProcess;
    if (file === "git") Object.defineProperty(child, "pid", { value: invalid });
    return child;
  }) as any);
  const kill = jest.spyOn(process, "kill"); const remove = jest.spyOn(fs, "rm");
  const { result } = acquire(); await ready();
  const outcome = await result;
  expect(outcome.error?.message).toBe("NATIVE_DIFF_LIFECYCLE_FAILED");
  expect(kill).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  expect(liveOwned()).toHaveLength(3); expect(existsSync(storage[0])).toBe(true);
  sentinelAlive();
});

test("N7: removal failure after a real command failure is sanitized and leaves owned recovery", async () => {
  installFixture({ descendants: false, stdout: encoded("prefix"), exit: 9 });
  const remove = jest.spyOn(fs, "rm").mockRejectedValueOnce(new Error("synthetic-token removal diagnostic"));
  const { result } = acquire(); await ready();
  const outcome = await result;
  expect(outcome.error?.message).toBe("NATIVE_DIFF_CLEANUP_FAILED"); expect(outcome.error?.cause).toBeUndefined();
  expect(outcome.value).toBeUndefined(); expect(remove).toHaveBeenCalledTimes(1);
  expect(liveOwned()).toEqual([]); expect(children[0].closed).toBe(true);
  expect(existsSync(storage[0])).toBe(true);
  await realRm(storage[0], { recursive: true, force: true });
  expect(existsSync(storage[0])).toBe(false); sentinelAlive();
});

test("N8: literal argv and stripped child environment keep fetch-only credentials private", async () => {
  const token = "synthetic-literal-token";
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const keys = ["GIT_TRACE", "GIT_TRACE_CURL", "GIT_CONFIG_PARAMETERS", "GIT_EXTERNAL_DIFF", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "SSH_ASKPASS"];
  const saved = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = "synthetic-host-injection";
  const realMkdtemp = fs.mkdtemp;
  const calls: { args: string[]; report: string }[] = [];
  jest.spyOn(fs, "mkdtemp").mockImplementation(() => realMkdtemp(join(control, "repo ; touch CANARY ; $() & ' ")));
  jest.spyOn(childProcess, "spawn").mockImplementation(((file: string, args: string[], opts: any) => {
    if (file !== "git") return realSpawn(file, args, opts);
    if (args.includes("init")) storage.push(args[args.length - 1]);
    expect(opts.shell).toBe(false); expect(opts.detached).toBe(true);
    expect(JSON.stringify(args)).not.toContain(token); expect(JSON.stringify(args)).not.toContain(auth);
    const report = `report-${calls.length}.json`;
    calls.push({ args: [...args], report });
    const output = args.includes("rev-parse") ? (args[args.length - 1].startsWith(snapshot.base) ? snapshot.base : snapshot.head) + "\n" :
      args.includes("merge-base") ? snapshot.base + "\n" : args.includes("--name-status") ? "A\0literal.txt\0" : args.includes("diff") ? "exact patch é\n" : "";
    writeFileSync(join(control, "go"), "go");
    return track(realSpawn(process.execPath, [fixture, "leader", control,
      JSON.stringify({ descendants: false, report, stdout: encoded(output), exit: 0 }), ...args], opts), true);
  }) as any);
  try {
    const verify = jest.fn().mockResolvedValue(undefined);
    const patch = await nativePullRequestDiff("fixture", "repository", token, snapshot, verify);
    expect(patch).toBe("exact patch é\n"); expect(verify).toHaveBeenCalledTimes(1);
    const reports = calls.map(call => JSON.parse(readFileSync(join(control, call.report), "utf8")));
    reports.forEach((report, index) => {
      expect(report.argv).toEqual(calls[index].args); expect(report.inherited).toEqual([]);
      expect(report.auth).toBe(calls[index].args.includes("fetch") ? `AUTHORIZATION: basic ${auth}` : null);
    });
    expect(reports.filter(report => report.auth)).toHaveLength(1);
    expect(calls[0].args[calls[0].args.length - 1]).toBe(storage[0]);
    expect(existsSync(join(control, "CANARY"))).toBe(false);
    expect(storage.every(directory => !existsSync(directory))).toBe(true); sentinelAlive();
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
});

test("N9: unsupported native platform rejects before private storage or process launch", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const launch = jest.spyOn(childProcess, "spawn"); const create = jest.spyOn(fs, "mkdtemp");
    const { result, verify } = acquire();
    const outcome = await result;
    expect(outcome.error?.message).toBe("NATIVE_DIFF_UNSUPPORTED_PLATFORM");
    expect(outcome.value).toBeUndefined(); expect(launch).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", platform); }
});


test.each(["owner", "sha"])("N8: untrusted %s cannot reach storage or a process", async field => {
  const launch = jest.spyOn(childProcess, "spawn"); const create = jest.spyOn(fs, "mkdtemp");
  await expect(nativePullRequestDiff(field === "owner" ? "fixture;touch CANARY" : "fixture", "repository", "synthetic-token",
    { ...snapshot, head: field === "sha" ? "--upload-pack=untrusted" : snapshot.head }, async () => {}))
    .rejects.toThrow(/^NATIVE_DIFF_INVALID_SNAPSHOT$/);
  expect(launch).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});

test("N6: synchronous probe kill errors cancel once and retain storage until owned recovery", async () => {
  jest.replaceProperty(nativeProcessLimits, "shutdownMs", 750);
  jest.replaceProperty(nativeProcessLimits, "probeMs", 200);
  const launch = installFixture({ stdout: encoded("prefix") });
  const fixtureSpawn = launch.getMockImplementation()!;
  const probes: { child: childProcess.ChildProcess; pid: number; attempts: number; ready: string; closed: boolean }[] = [];
  let group: number | undefined;
  jest.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (group && pid === -group && signal === "SIGKILL") {
      throw Object.assign(new Error("synthetic-token group signal"), { code: "EPERM" });
    }
    return fixtureKill(pid, signal);
  });
  launch.mockImplementation(((file: string, args: string[], options: any) => {
    if (file !== "ps") {
      const child = (fixtureSpawn as any)(file, args, options) as childProcess.ChildProcess;
      if (file === "git") group = child.pid;
      return child;
    }
    const ready = join(control, `probe-${probes.length}.ready`);
    const child = realSpawn(process.execPath, ["-e",
      "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", ready], options);
    const probe = { child, pid: child.pid!, attempts: 0, ready, closed: false };
    probes.push(probe);
    writeFileSync(join(control, "probe-pids.json"), JSON.stringify(probes.map(item => item.pid)));
    child.once("close", () => { probe.closed = true; });
    jest.spyOn(child, "kill").mockImplementation(() => {
      probe.attempts++;
      // One synchronous error already detects reentry; cap the injected error
      // count so a broken runner produces a bounded red without stack overflow.
      if (probe.attempts === 1) child.emit("error", Object.assign(new Error("synthetic-token probe signal"), { code: "EPERM" }));
      return false;
    });
    return child;
  }) as any);
  const remove = jest.spyOn(fs, "rm");
  let assertionFailure: unknown;
  try {
    const started = Date.now();
    const { result, verify } = acquire(); await ready();
    const outcome = await result;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(outcome.error?.message).toBe("NATIVE_DIFF_LIFECYCLE_FAILED");
    expect(outcome.error?.cause).toBeUndefined(); expect(outcome.value).toBeUndefined();
    expect(remove).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
    expect(storage).toHaveLength(1); expect(statSync(storage[0]).mode & 0o777).toBe(0o700);
    expect(liveOwned()).toHaveLength(3); expect(children[0].closed).toBe(false);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.some(probe => existsSync(probe.ready) && readFileSync(probe.ready, "utf8") === String(probe.pid))).toBe(true);
    const live = processes().filter(row => probes.some(probe => probe.pid === row.pid) && !row.state.startsWith("Z"));
    expect(live.map(row => row.pid).sort()).toEqual(probes.map(probe => probe.pid).sort());
    expect(probes.map(probe => probe.attempts)).toEqual(probes.map(() => 1));
    sentinelAlive();
  } catch (error) { assertionFailure = error; }

  // Recover only the captured group/PIDs after assertions, bypassing both fault
  // injections. Synthetic errors may distort close events; inspect OS states.
  const gitPids = ownedPids();
  const pids = [...gitPids, ...probes.map(probe => probe.pid)];
  let recoveryFailure: unknown;
  let liveAfterRecovery: number[] | undefined;
  try {
    const inventory = processes();
    if (group && group > 1 && inventory.some(row => row.pgid === group && gitPids.includes(row.pid))) {
      try { realProcessKill(-group, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    for (const probe of probes) {
      if (probe.pid > 1 && inventory.some(row => row.pid === probe.pid && row.ppid === process.pid && !row.state.startsWith("Z"))) {
        try { realProcessKill(probe.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    await until(() => {
      liveAfterRecovery = processes().filter(row => pids.includes(row.pid) && !row.state.startsWith("Z")).map(row => row.pid);
      return liveAfterRecovery.length === 0 && children.every(record => record.closed);
    }, "independent probe-fault recovery");
  } catch (error) { recoveryFailure = error; }
  console.info("N6_REENTRY_EVIDENCE", JSON.stringify({ control, group, gitPids,
    probes: probes.map(({ pid, attempts, closed }) => ({ pid, attempts, closeObserved: closed })),
    liveAfterRecovery, directChildClosed: children.every(record => record.closed),
    assertionFailed: assertionFailure !== undefined, recoveryFailed: recoveryFailure !== undefined }));
  if (assertionFailure) throw assertionFailure;
  if (recoveryFailure) throw recoveryFailure;
  expect(liveAfterRecovery).toEqual([]);
});
