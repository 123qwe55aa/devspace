import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec } from "./spec.js";
import { createRunStore } from "./run-store.js";

const spec: TaskSpec = {
  version: 1,
  project: "project",
  goal: "goal",
  architecturePlan: { summary: "architecture", modules: [] },
  tasks: [
    {
      id: "T1",
      title: "task",
      instruction: "instruction",
      files: [],
      constraints: [],
      acceptanceCriteria: [],
    },
  ],
};

const root = await mkdtemp(join(tmpdir(), "devspace-run-store-test-"));
const store = createRunStore(root);
const created = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "abc123",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec,
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});

assert.equal(created.state, "planned");
assert.equal(created.tasks[0]?.state, "pending");
assert.match(created.id, /^run_/);

await store.append(created.id, { type: "run_started" });
await store.append(created.id, {
  type: "task_attempt_started",
  taskId: "T1",
  attempt: 1,
  promptHash: "hash",
  promptPath: "tasks/T1/attempt-1.prompt.md",
  logPath: "tasks/T1/attempt-1.log",
});
assert.equal((await store.load(created.id)).tasks[0]?.state, "running");
assert.equal(await store.nextAttempt(created.id, "T1"), 2);

await writeFile(join(root, created.id, "run.json"), "{}\n");
assert.equal((await store.load(created.id)).tasks[0]?.state, "running");
assert.match(await readFile(join(root, created.id, "run.json"), "utf8"), /task/);

await appendFile(join(root, created.id, "events.jsonl"), '{"broken"');
assert.equal((await store.rebuildProjection(created.id)).state, "running");
await appendFile(join(root, created.id, "events.jsonl"), "\n{}\n");
await assert.rejects(() => store.rebuildProjection(created.id), /corrupt event/i);

const second = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "def456",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec,
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await appendFile(join(root, second.id, "events.jsonl"), '{"truncated"');
await store.append(second.id, { type: "run_failed", message: "recovered after interruption" });
assert.equal((await store.load(second.id)).state, "failed");

const lock = await store.acquireLock(second.id);
await assert.rejects(() => store.acquireLock(second.id), /already running/i);
await lock.release();
const reacquired = await store.acquireLock(second.id);
await reacquired.release();

const concurrent = await Promise.allSettled([
  store.acquireLock(second.id),
  store.acquireLock(second.id),
]);
assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
for (const result of concurrent) {
  if (result.status === "fulfilled") await result.value.release();
}

const invalidFinal = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "invalid-final",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec,
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await appendFile(join(root, invalidFinal.id, "events.jsonl"), '{"version":2}');
await assert.rejects(() => store.rebuildProjection(invalidFinal.id), /corrupt event/i);

const invalidSyntax = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "invalid-syntax",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec,
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await appendFile(join(root, invalidSyntax.id, "events.jsonl"), '{"version":]');
await assert.rejects(() => store.rebuildProjection(invalidSyntax.id), /corrupt event/i);

await assert.rejects(
  () => store.writeArtifact(second.id, "../outside", "no"),
  /inside the run directory/i,
);
const artifact = await store.writeArtifact(second.id, "tasks/T1/note.txt", "hello");
assert.equal(await readFile(artifact, "utf8"), "hello");
assert.equal((await store.list())[0]?.id, second.id);
assert.equal((await store.latest())?.id, second.id);
assert.deepEqual(await store.readSpec(second.id), spec);
