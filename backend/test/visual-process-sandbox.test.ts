import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalRestrictedExecutable,
  trustedPythonRuntimeRoots,
} from "../src/restricted-process.ts";
import {
  createVisualProcessSandboxLaunchSpec,
  createVisualProcessSandboxProfile,
  type VisualProcessSandboxInput,
  VisualProcessSandboxError,
} from "../src/visual-process-sandbox.ts";

type Fixture = Readonly<{
  parent: string;
  input: Omit<VisualProcessSandboxInput, "assignedPort">;
}>;

const createFixture = (): Fixture => {
  const parent = mkdtempSync(join(tmpdir(), "riff-visual-sandbox-"));
  const scratchRoot = join(parent, "scratch");
  const projectRoot = join(scratchRoot, "project");
  const outputRoot = join(scratchRoot, "outputs");
  const tempRoot = join(scratchRoot, "tmp");
  mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const inputPath = join(scratchRoot, "input.json");
  const launchReceiptPath = join(scratchRoot, "launch-receipt.json");
  writeFileSync(join(projectRoot, "model.py"), "print('visual')\n", { mode: 0o600 });
  writeFileSync(inputPath, "{}\n", { mode: 0o600 });
  writeFileSync(join(scratchRoot, "private-state.json"), "secret\n", { mode: 0o600 });
  const requestedPython = "/usr/bin/python3";
  const executable = canonicalRestrictedExecutable(requestedPython);
  return Object.freeze({
    parent,
    input: Object.freeze({
      projectRoot,
      inputPath,
      outputRoot,
      scratchRoot,
      tempRoot,
      launchReceiptPath,
      executable: requestedPython,
      runtimeReadRoots: Object.freeze(
        trustedPythonRuntimeRoots(requestedPython, executable)
          .filter((root) => {
            try {
              realpathSync(root);
              return true;
            } catch {
              return false;
            }
          }),
      ),
      assignedHost: "127.0.0.1",
    }),
  });
};

const closeFixture = (fixture: Fixture): void => {
  rmSync(fixture.parent, { recursive: true, force: true });
};

const listen = async (): Promise<Server> => {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return server;
};

const portOf = (server: Server): number => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IPv4 listener.");
  return address.port;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose()));
};

const allocateClosedPort = async (): Promise<number> => {
  const server = await listen();
  const port = portOf(server);
  await closeServer(server);
  return port;
};

const runSandboxedPython = async (
  fixture: Fixture,
  assignedPort: number,
  code: string,
): Promise<Readonly<{ exitCode: number | null; stdout: string; stderr: string }>> => {
  const spec = createVisualProcessSandboxLaunchSpec({
    ...fixture.input,
    assignedPort,
    childArgv: ["-I", "-c", code],
  });
  const child = spawn(spec.sandboxExecutable, spec.argv, {
    cwd: spec.cwd,
    env: {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PYTHONHASHSEED: "0",
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      TMPDIR: spec.tempRoot,
      __CF_USER_TEXT_ENCODING: "0x0:0:0",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return Object.freeze({ exitCode, stdout, stderr });
};

const bindProbe = (host: string, port: number, family: "ipv4" | "ipv6"): string => `
import errno,json,socket,sys
family = socket.AF_INET if ${JSON.stringify(family)} == "ipv4" else socket.AF_INET6
s = socket.socket(family, socket.SOCK_STREAM)
try:
    s.bind((${JSON.stringify(host)}, ${port}))
    s.listen(1)
    print(json.dumps({"result":"bound","address":s.getsockname()}))
except OSError as error:
    print(json.dumps({"result":"denied","errno":error.errno,"message":str(error)}))
    sys.exit(73 if error.errno in (errno.EPERM, errno.EACCES) else 74)
`;

test("visual sandbox profile is visual-only, port-scoped, outbound-denying, and explicitly requires OS listener compensation", () => {
  const fixture = createFixture();
  try {
    const profile = createVisualProcessSandboxProfile({
      ...fixture.input,
      assignedPort: 42_123,
    });
    assert.deepEqual(profile.isolation, {
      kind: "macos-seatbelt-ipv4-port",
      assignedHost: "127.0.0.1",
      assignedPort: 42_123,
      outboundNetwork: "denied",
      endpointIsolation: "requires-os-listener-closed-set",
      requiresOsListenerClosedSet: true,
      limitation: "seatbelt-localhost-filter-allows-ipv4-wildcard",
    });
    assert.match(
      profile.profile,
      /\(allow network-bind \(local tcp4 "localhost:42123"\)\)/u,
    );
    assert.match(
      profile.profile,
      /\(allow network-inbound \(local tcp4 "localhost:42123"\)\)/u,
    );
    assert.doesNotMatch(profile.profile, /allow network-outbound/u);
    assert.doesNotMatch(profile.profile, /\(allow network\*\)/u);
    assert.doesNotMatch(
      profile.profile,
      new RegExp(`\\(subpath "${profile.scratchRoot.replaceAll("\\", "\\\\")}"\\)`, "u"),
    );
    assert.equal(profile.launchReceiptPath, realpathSync(fixture.input.scratchRoot)
      + "/launch-receipt.json");
    assert.equal(existsSync(fixture.input.launchReceiptPath!), false);
    const launch = createVisualProcessSandboxLaunchSpec({
      ...fixture.input,
      assignedPort: 42_123,
      childArgv: ["-I", "-c", "pass"],
    });
    assert.equal(launch.cwd, realpathSync(fixture.input.projectRoot));
    assert.deepEqual(
      launch.argv.slice(0, 3),
      ["-p", launch.profile, launch.executable],
    );
    assert.deepEqual(
      launch.argv.slice(-4),
      ["--riff-host", "127.0.0.1", "--riff-port", "42123"],
    );
    assert.equal("env" in launch, false);
  } finally {
    closeFixture(fixture);
  }
});

test("visual sandbox rejects caller host/port widening, broad runtime roots, and unsupported fields", () => {
  const fixture = createFixture();
  const outside = mkdtempSync(join(tmpdir(), "riff-visual-runtime-outside-"));
  try {
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      assignedHost: "0.0.0.0" as "127.0.0.1",
      assignedPort: 42_123,
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_endpoint");
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      assignedPort: 0,
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_endpoint");
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      runtimeReadRoots: [...fixture.input.runtimeReadRoots, outside],
      assignedPort: 42_123,
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_runtime_root");
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      assignedPort: 42_123,
      environment: { SECRET: "must-not-enter-profile" },
    } as VisualProcessSandboxInput), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_sandbox_input");
    assert.throws(() => createVisualProcessSandboxLaunchSpec({
      ...fixture.input,
      assignedPort: 42_123,
      childArgv: ["--riff-host", "0.0.0.0"],
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_argv");
    assert.throws(() => createVisualProcessSandboxLaunchSpec({
      ...fixture.input,
      assignedPort: 42_123,
      childArgv: ["-I", "--", "--riff-host", "0.0.0.0"],
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_argv");
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      outputRoot: fixture.input.scratchRoot,
      assignedPort: 42_123,
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_path");
    const linkedReceipt = join(fixture.input.scratchRoot, "linked-receipt.json");
    symlinkSync(fixture.input.inputPath, linkedReceipt);
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      launchReceiptPath: linkedReceipt,
      assignedPort: 42_123,
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_path");
    const existingReceipt = join(fixture.input.scratchRoot, "existing-receipt.json");
    writeFileSync(existingReceipt, "{}\n", { mode: 0o400 });
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      launchReceiptPath: existingReceipt,
      assignedPort: 42_123,
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_path");
    assert.throws(() => createVisualProcessSandboxProfile({
      ...fixture.input,
      launchReceiptPath: join(fixture.input.projectRoot, "launch-receipt.json"),
      assignedPort: 42_123,
    }), (error: unknown) =>
      error instanceof VisualProcessSandboxError
      && error.code === "invalid_visual_path");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    closeFixture(fixture);
  }
});

test("macOS visual sandbox keeps nested Project/input/scratch state read-only and creates one exact receipt", {
  skip: process.platform !== "darwin",
}, async () => {
  const fixture = createFixture();
  try {
    const port = await allocateClosedPort();
    const canonical = createVisualProcessSandboxProfile({
      ...fixture.input,
      assignedPort: port,
    });
    const result = await runSandboxedPython(fixture, port, `
import errno,json
import os
from pathlib import Path
project = Path(${JSON.stringify(canonical.projectRoot)})
input_path = Path(${JSON.stringify(canonical.inputPath)})
output = Path(${JSON.stringify(canonical.outputRoot)}) / "result.json"
temp = Path(${JSON.stringify(canonical.tempRoot)}) / "temp.json"
scratch = Path(${JSON.stringify(canonical.scratchRoot)})
receipt = Path(${JSON.stringify(canonical.launchReceiptPath)})
payload = {"model":(project / "model.py").read_text(),"input":input_path.read_text()}
output.write_text("{}")
temp.write_text("{}")
fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
os.write(fd, b'{"created":true}\\n')
os.close(fd)
denied_writes = []
for target in (project / "forbidden.txt", input_path, scratch / "state.json", receipt):
    try:
        target.write_text("forbidden")
    except OSError as error:
        denied_writes.append(error.errno in (errno.EPERM, errno.EACCES))
try:
    receipt.chmod(0o600)
except OSError as error:
    denied_writes.append(error.errno in (errno.EPERM, errno.EACCES))
try:
    receipt.unlink()
except OSError as error:
    denied_writes.append(error.errno in (errno.EPERM, errno.EACCES))
denied_reads = []
for target in (scratch / "private-state.json", receipt):
    try:
        target.read_text()
    except OSError as error:
        denied_reads.append(error.errno in (errno.EPERM, errno.EACCES))
print(json.dumps({
    "payload":payload,
    "denied_writes":denied_writes,
    "denied_reads":denied_reads,
}))
`);
    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.payload.model, /visual/u);
    assert.equal(payload.payload.input, "{}\n");
    assert.deepEqual(payload.denied_writes, [true, true, true, true, true, true]);
    assert.deepEqual(payload.denied_reads, [true, true]);
    assert.equal(
      readFileSync(canonical.launchReceiptPath!, "utf8"),
      "{\"created\":true}\n",
    );
  } finally {
    closeFixture(fixture);
  }
});

test("macOS Seatbelt permits only the assigned IPv4 port, denies IPv6 and outbound, but wildcard requires OS closed-set compensation", {
  skip: process.platform !== "darwin",
}, async () => {
  const fixture = createFixture();
  const liveServer = await listen();
  let acceptedConnections = 0;
  liveServer.on("connection", (socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  try {
    const assignedPort = await allocateClosedPort();
    let otherPort = await allocateClosedPort();
    while (otherPort === assignedPort || otherPort === portOf(liveServer)) {
      otherPort = await allocateClosedPort();
    }

    const assigned = await runSandboxedPython(
      fixture,
      assignedPort,
      bindProbe("127.0.0.1", assignedPort, "ipv4"),
    );
    assert.equal(assigned.exitCode, 0, assigned.stderr);
    assert.equal(JSON.parse(assigned.stdout).result, "bound");

    const other = await runSandboxedPython(
      fixture,
      assignedPort,
      bindProbe("127.0.0.1", otherPort, "ipv4"),
    );
    assert.equal(other.exitCode, 73, other.stderr);
    assert.equal(JSON.parse(other.stdout).errno, 1);

    const ipv6 = await runSandboxedPython(
      fixture,
      assignedPort,
      bindProbe("::1", assignedPort, "ipv6"),
    );
    assert.equal(ipv6.exitCode, 73, ipv6.stderr);
    assert.equal(JSON.parse(ipv6.stdout).errno, 1);

    // This is the empirically verified Seatbelt limitation. The API contract
    // marks the profile unusable without a later exact OS listener closed-set
    // check, which must reject this wildcard listener before health/success.
    const wildcard = await runSandboxedPython(
      fixture,
      assignedPort,
      bindProbe("0.0.0.0", assignedPort, "ipv4"),
    );
    assert.equal(wildcard.exitCode, 0, wildcard.stderr);
    assert.equal(JSON.parse(wildcard.stdout).result, "bound");
    assert.equal(createVisualProcessSandboxProfile({
      ...fixture.input,
      assignedPort,
    }).isolation.requiresOsListenerClosedSet, true);

    const connect = await runSandboxedPython(fixture, assignedPort, `
import errno,json,socket,sys
try:
    socket.create_connection(("127.0.0.1", ${portOf(liveServer)}), timeout=1)
    print(json.dumps({"result":"connected"}))
except OSError as error:
    print(json.dumps({"result":"denied","errno":error.errno,"message":str(error)}))
    sys.exit(73 if error.errno in (errno.EPERM, errno.EACCES) else 74)
`);
    assert.equal(connect.exitCode, 73, connect.stderr);
    assert.equal(JSON.parse(connect.stdout).errno, 1);
    assert.equal(acceptedConnections, 0);
  } finally {
    await closeServer(liveServer);
    closeFixture(fixture);
  }
});
