import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  inspectVisualListener,
  inspectVisualListenerAsync,
  inspectVisualConnectedPeer,
  inspectVisualConnectedPeerAsync,
  selectVisualLoopbackPort,
  VisualListenerInspectionError,
  type VisualListenerInspectionCode,
  type VisualListenerInspectionInput,
  type VisualListenerInspectorDependencies,
} from "../src/visual-listener-inspector.ts";

const ASSIGNED_PORT = 41_000;
const START_TOKEN = "Fri Jul 25 10:00:00 2026";
const BASE_INPUT: VisualListenerInspectionInput = Object.freeze({
  runId: "run_visual_listener",
  processAttemptId: "process_visual_listener",
  pid: 100,
  processStartToken: START_TOKEN,
  processGroupId: 100,
  assignedPort: ASSIGNED_PORT,
});

type FixtureOptions = Readonly<{
  firstPs?: string;
  lsof?: string;
  secondPs?: string;
  psStatus?: number;
  lsofStatus?: number;
  lsofStderr?: string;
  throwAt?: number;
}>;

const PS = `  100   100 ${START_TOKEN}\n`;

const dependencies = (options: FixtureOptions = {}): VisualListenerInspectorDependencies => {
  let call = 0;
  return {
    platform: "darwin",
    runCommand(file) {
      call += 1;
      if (options.throwAt === call) throw new Error("injected command failure");
      if (file === "/bin/ps") {
        const stdout = call === 1
          ? options.firstPs ?? PS
          : options.secondPs ?? options.firstPs ?? PS;
        return { status: options.psStatus ?? 0, stdout, stderr: "" };
      }
      assert.equal(file, "/usr/sbin/lsof");
      return {
        status: options.lsofStatus ?? 0,
        stdout: options.lsof ?? "",
        stderr: options.lsofStderr ?? "",
      };
    },
  };
};

const lsof = (...records: readonly [number, string][]): string =>
  records.map(([pid, endpoint], index) =>
    `p${pid}\0f${10 + index}\0n${endpoint}\0\n`).join("");

const expectCode = (
  code: VisualListenerInspectionCode,
  options: FixtureOptions,
  input: VisualListenerInspectionInput = BASE_INPUT,
): void => {
  assert.throws(
    () => inspectVisualListener(input, dependencies(options)),
    (error: unknown) => {
      assert.ok(error instanceof VisualListenerInspectionError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(String(input.assignedPort)), false);
      assert.equal(JSON.stringify({ code: error.code, message: error.message })
        .includes(String(input.assignedPort)), false);
      return true;
    },
  );
};

test("selectVisualLoopbackPort uses literal IPv4 loopback and releases the non-reserved candidate", async () => {
  const port = await selectVisualLoopbackPort();
  assert.equal(Number.isSafeInteger(port) && port >= 1 && port <= 65_535, true);
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose()));
});

test("async inspector performs bounded OS reads without blocking the event loop", async () => {
  const sync = dependencies({ lsof: lsof([100, `127.0.0.1:${ASSIGNED_PORT}`]) });
  let ticked = false;
  const pending = inspectVisualListenerAsync(BASE_INPUT, {
    platform: "darwin",
    runCommand: async (file, args) => {
      await delay(1);
      return sync.runCommand!(file, args);
    },
  });
  setImmediate(() => {
    ticked = true;
  });
  assert.deepEqual(await pending, { kind: "ready" });
  assert.equal(ticked, true);
});

test("connected-peer inspector binds the exact established four-tuple to the process group", async () => {
  const input = Object.freeze({ ...BASE_INPUT, brokerLocalPort: 52_345 });
  const exact = dependencies({
    lsof: lsof([100, `127.0.0.1:${ASSIGNED_PORT}->127.0.0.1:${input.brokerLocalPort}`]),
  });
  assert.deepEqual(inspectVisualConnectedPeer(input, exact), { kind: "ready" });
  const asyncEvidence = dependencies({
    lsof: lsof([100, `127.0.0.1:${ASSIGNED_PORT}->127.0.0.1:${input.brokerLocalPort}`]),
  });
  assert.deepEqual(await inspectVisualConnectedPeerAsync(input, {
    platform: "darwin",
    runCommand: async (file, args) => asyncEvidence.runCommand!(file, args),
  }), { kind: "ready" });
  assert.throws(
    () => inspectVisualConnectedPeer(input, dependencies({
      firstPs: `${PS}  200   200 ${START_TOKEN}\n`,
      lsof: lsof([200, `127.0.0.1:${ASSIGNED_PORT}->127.0.0.1:${input.brokerLocalPort}`]),
    })),
    (error: unknown) => error instanceof VisualListenerInspectionError
      && error.code === "visual_socket_foreign_owner",
  );
  assert.throws(
    () => inspectVisualConnectedPeer(input, dependencies({
      lsof: lsof([100, `127.0.0.1:${ASSIGNED_PORT}->127.0.0.1:${input.brokerLocalPort + 1}`]),
    })),
    (error: unknown) => error instanceof VisualListenerInspectionError
      && error.code === "visual_socket_missing",
  );
});

test("injected OS evidence classifies exact readiness and every fail-closed listener shape", async (t) => {
  await t.test("exact", () => {
    assert.deepEqual(
      inspectVisualListener(
        BASE_INPUT,
        dependencies({ lsof: lsof([100, `127.0.0.1:${ASSIGNED_PORT}`]) }),
      ),
      { kind: "ready" },
    );
  });
  await t.test("missing", () =>
    expectCode("visual_listener_missing", { lsof: "" }));
  await t.test("wildcard", () =>
    expectCode("visual_listener_wildcard", {
      lsof: lsof([100, `*:${ASSIGNED_PORT}`]),
    }));
  await t.test("wrong port", () =>
    expectCode("visual_listener_wrong_port", {
      lsof: lsof([100, `127.0.0.1:${ASSIGNED_PORT + 1}`]),
    }));
  await t.test("extra IPv4", () =>
    expectCode("visual_listener_extra_ipv4", {
      lsof: lsof(
        [100, `127.0.0.1:${ASSIGNED_PORT}`],
        [100, `127.0.0.1:${ASSIGNED_PORT + 1}`],
      ),
    }));
  await t.test("non-loopback IPv4", () =>
    expectCode("visual_listener_extra_ipv4", {
      lsof: lsof([100, `192.0.2.10:${ASSIGNED_PORT}`]),
    }));
  await t.test("IPv6", () =>
    expectCode("visual_listener_ipv6", {
      lsof: lsof([100, `[::1]:${ASSIGNED_PORT}`]),
    }));
  await t.test("foreign owner", () =>
    expectCode("visual_listener_foreign_owner", {
      firstPs: `${PS}  200   200 ${START_TOKEN}\n`,
      lsof: lsof([200, `127.0.0.1:${ASSIGNED_PORT}`]),
    }));
  await t.test("ambiguous owners", () =>
    expectCode("visual_listener_ambiguous", {
      firstPs: `${PS}  200   200 ${START_TOKEN}\n`,
      lsof: lsof(
        [100, `127.0.0.1:${ASSIGNED_PORT}`],
        [200, `127.0.0.1:${ASSIGNED_PORT}`],
      ),
    }));
  await t.test("process-group observation changed", () =>
    expectCode("visual_listener_ambiguous", {
      lsof: lsof([100, `127.0.0.1:${ASSIGNED_PORT}`]),
      secondPs: `${PS}  101   100 ${START_TOKEN}\n`,
    }));
  await t.test("identity mismatch", () =>
    expectCode("visual_listener_identity_mismatch", {
      firstPs: `  100   100 Sat Jul 26 10:00:00 2026\n`,
    }));
  await t.test("parser failure", () =>
    expectCode("visual_listener_parser_failure", { lsof: "not-field-output" }));
  await t.test("tool failure", () =>
    expectCode("visual_listener_tool_failure", {
      lsofStatus: 2,
      lsofStderr: "injected tool detail with 41000",
    }));
  await t.test("thrown tool failure", () =>
    expectCode("visual_listener_tool_failure", { throwAt: 2 }));
  await t.test("unsupported platform", () => {
    assert.throws(
      () => inspectVisualListener(BASE_INPUT, { platform: "linux" }),
      (error: unknown) =>
        error instanceof VisualListenerInspectionError
        && error.code === "visual_listener_platform_unsupported",
    );
  });
  await t.test("invalid input", () => {
    expectCode(
      "visual_listener_invalid_input",
      {},
      { ...BASE_INPUT, assignedPort: 0 },
    );
  });
});

type RealChild = Readonly<{
  child: ChildProcess;
  lines: string[];
  waitForLine: (expected: string, after?: number) => Promise<void>;
  input: VisualListenerInspectionInput;
}>;

const CHILD_SCRIPT = String.raw`
const net = require("node:net");
const readline = require("node:readline");
const servers = [];
let connections = 0;
const held = [];
const bind = (spec) => new Promise((resolve, reject) => {
  const server = net.createServer((socket) => {
    connections += 1;
    process.stdout.write("connection\n");
    if (spec.hold) held.push(socket);
    else socket.destroy();
  });
  server.once("error", reject);
  server.listen({host: spec.host, port: spec.port, exclusive: true}, () => {
    servers.push(server);
    resolve();
  });
});
const initial = JSON.parse(process.argv[1]);
Promise.all(initial.map(bind)).then(() => process.stdout.write("ready\n"), (error) => {
  process.stderr.write(String(error));
  process.exit(2);
});
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const command = JSON.parse(line);
  bind(command).then(() => process.stdout.write("bound\n"), () => process.exit(3));
});
const close = () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  .finally(() => process.exit(0));
process.on("SIGTERM", close);
setInterval(() => {}, 1000);
`;

const startRealChild = async (
  specs: readonly Readonly<{ host: string; port: number; hold?: boolean }>[],
  assignedPort: number,
  suffix: string,
): Promise<RealChild> => {
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT, JSON.stringify(specs)], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { LANG: "C", LC_ALL: "C" },
  });
  assert.ok(child.pid);
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    lines.push(line);
    for (const notify of waiters) notify();
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const waitForLine = async (expected: string, after = 0): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!lines.slice(after).includes(expected)) {
      if (child.exitCode !== null) throw new Error(`listener child exited: ${stderr}`);
      if (Date.now() >= deadline) throw new Error(`listener child did not report ${expected}`);
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(() => {
          waiters.delete(notify);
          resolveWait();
        }, 25);
        const notify = (): void => {
          clearTimeout(timer);
          waiters.delete(notify);
          resolveWait();
        };
        waiters.add(notify);
      });
    }
  };
  await waitForLine("ready");
  const identity = spawnSync(
    "/bin/ps",
    ["-o", "pgid=", "-o", "lstart=", "-p", String(child.pid)],
    { encoding: "utf8", env: { LANG: "C", LC_ALL: "C" } },
  );
  assert.equal(identity.status, 0);
  const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(identity.stdout);
  assert.ok(match);
  return Object.freeze({
    child,
    lines,
    waitForLine,
    input: Object.freeze({
      runId: `run_${suffix}`,
      processAttemptId: `process_${suffix}`,
      pid: child.pid,
      processStartToken: match[2]!,
      processGroupId: Number(match[1]),
      assignedPort,
    }),
  });
};

const stopRealChild = async (fixture: RealChild): Promise<void> => {
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null || !fixture.child.pid) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(resolveStop, 2_000);
    fixture.child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    try {
      fixture.child.kill("SIGKILL");
    } catch {
      clearTimeout(timeout);
      resolveStop();
    }
  });
};

const bindRealChild = async (
  fixture: RealChild,
  spec: Readonly<{ host: string; port: number }>,
): Promise<void> => {
  const after = fixture.lines.length;
  fixture.child.stdin!.write(`${JSON.stringify(spec)}\n`);
  await fixture.waitForLine("bound", after);
};

test("Darwin inspector observes real exact, wildcard, extra, and foreign-replacement listeners without HTTP", {
  skip: process.platform !== "darwin",
}, async (t) => {
  await t.test("exact readiness makes zero connections", async () => {
    const assignedPort = await selectVisualLoopbackPort();
    const fixture = await startRealChild(
      [{ host: "127.0.0.1", port: assignedPort }],
      assignedPort,
      "real_exact",
    );
    try {
      assert.deepEqual(inspectVisualListener(fixture.input), { kind: "ready" });
      assert.deepEqual(await inspectVisualListenerAsync(fixture.input), { kind: "ready" });
      await delay(50);
      assert.equal(fixture.lines.includes("connection"), false);
    } finally {
      await stopRealChild(fixture);
    }
  });

  await t.test("wildcard", async () => {
    const assignedPort = await selectVisualLoopbackPort();
    const fixture = await startRealChild(
      [{ host: "0.0.0.0", port: assignedPort }],
      assignedPort,
      "real_wildcard",
    );
    try {
      assert.throws(
        () => inspectVisualListener(fixture.input),
        (error: unknown) =>
          error instanceof VisualListenerInspectionError
          && error.code === "visual_listener_wildcard",
      );
    } finally {
      await stopRealChild(fixture);
    }
  });

  await t.test("extra IPv4", async () => {
    const assignedPort = await selectVisualLoopbackPort();
    const extraPort = await selectVisualLoopbackPort();
    const fixture = await startRealChild([
      { host: "127.0.0.1", port: assignedPort },
      { host: "127.0.0.1", port: extraPort },
    ], assignedPort, "real_extra");
    try {
      assert.throws(
        () => inspectVisualListener(fixture.input),
        (error: unknown) =>
          error instanceof VisualListenerInspectionError
          && error.code === "visual_listener_extra_ipv4",
      );
    } finally {
      await stopRealChild(fixture);
    }
  });

  await t.test("foreign owner is replaced by the exact target without probing it", async () => {
    const assignedPort = await selectVisualLoopbackPort();
    const target = await startRealChild([], assignedPort, "real_replacement");
    const foreign = await startRealChild(
      [{ host: "127.0.0.1", port: assignedPort }],
      assignedPort,
      "real_foreign",
    );
    try {
      assert.throws(
        () => inspectVisualListener(target.input),
        (error: unknown) =>
          error instanceof VisualListenerInspectionError
          && error.code === "visual_listener_foreign_owner",
      );
      await stopRealChild(foreign);
      await bindRealChild(target, { host: "127.0.0.1", port: assignedPort });
      assert.deepEqual(inspectVisualListener(target.input), { kind: "ready" });
      assert.equal(target.lines.includes("connection"), false);
    } finally {
      await stopRealChild(foreign);
      await stopRealChild(target);
    }
  });

  await t.test("established peer belongs to the exact child process group and four-tuple", async () => {
    const assignedPort = await selectVisualLoopbackPort();
    const fixture = await startRealChild(
      [{ host: "127.0.0.1", port: assignedPort, hold: true }],
      assignedPort,
      "real_connected",
    );
    const socket = connect({ host: "127.0.0.1", port: assignedPort });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      await fixture.waitForLine("connection");
      assert.ok(socket.localPort);
      assert.deepEqual(inspectVisualConnectedPeer({
        ...fixture.input,
        brokerLocalPort: socket.localPort,
      }), { kind: "ready" });
    } finally {
      socket.destroy();
      await stopRealChild(fixture);
    }
  });
});
