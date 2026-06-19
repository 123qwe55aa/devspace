import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCliWorker } from "./backend.js";
import type { ExecutionTask } from "./compiler.js";

const root = await mkdtemp(join(tmpdir(), "devspace-backend-test-"));
const executable = join(root, "fake-codex.mjs");
const capturePath = join(root, "prompt.txt");
const logPath = join(root, "worker.log");
await writeFile(
  executable,
  `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0");
  process.exit(0);
}
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
await writeFile(process.env.CAPTURE_PATH, prompt);
console.log("stdout message");
console.error("stderr message");
process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
`,
);
await chmod(executable, 0o755);

const task: ExecutionTask = {
  runId: "run_1",
  taskId: "T1",
  baseSha: "abc123",
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
  prompt: "assigned task",
  promptHash: "hash",
};
const worker = new CodexCliWorker({
  executable,
  env: { ...process.env, CAPTURE_PATH: capturePath, FAKE_CODEX_EXIT: "0" },
});
assert.match(await worker.version(), /fake-codex 1\.0/);
const previousExecutable = process.env.DEVSPACE_CODEX_BIN;
process.env.DEVSPACE_CODEX_BIN = executable;
assert.match(await new CodexCliWorker().version(), /fake-codex 1\.0/);
if (previousExecutable === undefined) delete process.env.DEVSPACE_CODEX_BIN;
else process.env.DEVSPACE_CODEX_BIN = previousExecutable;
const result = await worker.run({
  task,
  cwd: root,
  logPath,
  signal: new AbortController().signal,
});
assert.equal(result.exitCode, 0);
assert.deepEqual(result.args.slice(0, 2), ["exec", "--ephemeral"]);
assert.match(await readFile(capturePath, "utf8"), /assigned task/);
assert.match(await readFile(logPath, "utf8"), /stdout message/);
assert.match(await readFile(logPath, "utf8"), /stderr message/);

const failing = new CodexCliWorker({
  executable,
  env: { ...process.env, CAPTURE_PATH: capturePath, FAKE_CODEX_EXIT: "7" },
});
assert.equal(
  (
    await failing.run({
      task,
      cwd: root,
      logPath,
      signal: new AbortController().signal,
    })
  ).exitCode,
  7,
);
