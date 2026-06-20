import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followRunLogs } from "./log-follower.js";
import { createRunStore } from "./run-store.js";
import type { TaskSpec } from "./spec.js";

const spec: TaskSpec = {
  version: 1,
  project: "project",
  goal: "follow logs",
  architecturePlan: { summary: "two tasks", modules: [] },
  tasks: ["T1", "T2"].map((id) => ({
    id,
    title: id,
    instruction: id,
    files: [],
    constraints: [],
    acceptanceCriteria: [],
  })),
};

const root = await mkdtemp(join(tmpdir(), "devspace-log-follower-test-"));
const store = createRunStore(root);
const run = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "abc123",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec,
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await store.append(run.id, { type: "run_started" });
const t1Log = await store.writeArtifact(run.id, "tasks/T1/attempt-1.log", "first\n");
await store.append(run.id, {
  type: "task_attempt_started",
  taskId: "T1",
  attempt: 1,
  promptHash: "one",
  promptPath: "tasks/T1/attempt-1.prompt.md",
  logPath: "tasks/T1/attempt-1.log",
});

const utf8 = Buffer.from("化");
let step = 0;
let output = "";
await followRunLogs({
  store,
  runId: run.id,
  output: { write: (chunk) => { output += chunk; } },
  wait: async () => {
    step += 1;
    if (step === 1) {
      await appendFile(t1Log, utf8.subarray(0, 2));
      return;
    }
    if (step === 2) {
      await appendFile(t1Log, Buffer.concat([utf8.subarray(2), Buffer.from("\n")]));
      await store.append(run.id, {
        type: "task_attempt_exited",
        taskId: "T1",
        attempt: 1,
        exitCode: 0,
        signal: null,
      });
      await store.append(run.id, { type: "task_completed", taskId: "T1", attempt: 1 });
      await store.append(run.id, {
        type: "task_attempt_started",
        taskId: "T2",
        attempt: 1,
        promptHash: "two",
        promptPath: "tasks/T2/attempt-1.prompt.md",
        logPath: "tasks/T2/attempt-1.log",
      });
      return;
    }
    assert.equal(step, 3);
    await store.writeArtifact(run.id, "tasks/T2/attempt-1.log", "second\n");
    await store.append(run.id, {
      type: "task_attempt_exited",
      taskId: "T2",
      attempt: 1,
      exitCode: 0,
      signal: null,
    });
    await store.append(run.id, { type: "task_completed", taskId: "T2", attempt: 1 });
    await store.append(run.id, { type: "run_completed" });
  },
});
assert.equal(output, "==> T1 attempt 1 <==\nfirst\n化\n==> T2 attempt 1 <==\nsecond\n");

const aborted = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "def456",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec: { ...spec, tasks: [spec.tasks[0]!] },
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await store.append(aborted.id, { type: "run_started" });
await store.writeArtifact(aborted.id, "tasks/T1/attempt-1.log", "waiting\n");
await store.append(aborted.id, {
  type: "task_attempt_started",
  taskId: "T1",
  attempt: 1,
  promptHash: "abort",
  promptPath: "tasks/T1/attempt-1.prompt.md",
  logPath: "tasks/T1/attempt-1.log",
});
const eventsPath = join(root, aborted.id, "events.jsonl");
const before = await readFile(eventsPath, "utf8");
const controller = new AbortController();
await followRunLogs({
  store,
  runId: aborted.id,
  output: { write: () => undefined },
  signal: controller.signal,
  wait: async () => { controller.abort(); },
});
assert.equal(await readFile(eventsPath, "utf8"), before);

const truncated = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "ghi789",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec: { ...spec, tasks: [spec.tasks[0]!] },
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await store.append(truncated.id, { type: "run_started" });
const truncatedLog = await store.writeArtifact(
  truncated.id,
  "tasks/T1/attempt-1.log",
  "old-old\n",
);
await store.append(truncated.id, {
  type: "task_attempt_started",
  taskId: "T1",
  attempt: 1,
  promptHash: "truncate",
  promptPath: "tasks/T1/attempt-1.prompt.md",
  logPath: "tasks/T1/attempt-1.log",
});
let truncatedOutput = "";
await followRunLogs({
  store,
  runId: truncated.id,
  output: { write: (chunk) => { truncatedOutput += chunk; } },
  wait: async () => {
    await writeFile(truncatedLog, "new\n");
    await store.append(truncated.id, {
      type: "task_attempt_exited",
      taskId: "T1",
      attempt: 1,
      exitCode: 0,
      signal: null,
    });
    await store.append(truncated.id, { type: "task_completed", taskId: "T1", attempt: 1 });
    await store.append(truncated.id, { type: "run_completed" });
  },
});
assert.equal(truncatedOutput, "==> T1 attempt 1 <==\nold-old\nnew\n");

const failed = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "terminal",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec: { ...spec, tasks: [spec.tasks[0]!] },
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await store.append(failed.id, { type: "run_started" });
await store.append(failed.id, { type: "run_failed", message: "stopped before task launch" });
let failedOutput = "";
await followRunLogs({
  store,
  runId: failed.id,
  output: { write: (chunk) => { failedOutput += chunk; } },
});
assert.equal(failedOutput, "");
