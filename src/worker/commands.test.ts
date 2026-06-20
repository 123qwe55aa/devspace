import assert from "node:assert/strict";
import {
  formatRunList,
  formatRunStatus,
  parseWorkerCommand,
  resolveLogsRun,
} from "./commands.js";
import type { RunProjection } from "./events.js";

assert.deepEqual(parseWorkerCommand("run", []), { kind: "run-new" });
assert.deepEqual(parseWorkerCommand("run", ["run_123"]), {
  kind: "run-resume",
  runId: "run_123",
});
assert.deepEqual(parseWorkerCommand("status", []), { kind: "status-latest" });
assert.deepEqual(parseWorkerCommand("status", ["run_123"]), {
  kind: "status",
  runId: "run_123",
});
assert.deepEqual(parseWorkerCommand("runs", []), { kind: "runs" });
assert.deepEqual(parseWorkerCommand("logs", []), { kind: "logs-latest" });
assert.deepEqual(parseWorkerCommand("logs", ["run_123"]), {
  kind: "logs",
  runId: "run_123",
});
assert.throws(() => parseWorkerCommand("runs", ["extra"]), /does not accept arguments/);
assert.throws(() => parseWorkerCommand("run", ["one", "two"]), /at most one run id/);
assert.throws(() => parseWorkerCommand("logs", ["one", "two"]), /at most one run id/);

const completed: RunProjection = {
  id: "run_123",
  state: "completed",
  sourceProject: "/tmp/project",
  baseSha: "abc123",
  specPath: "/tmp/project/.devspace/spec/current.json",
  worktreePath: "/tmp/worktree",
  dirtySource: true,
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:01:00.000Z",
  tasks: [{ id: "T1", title: "Task one", state: "completed", attempts: 1 }],
};

assert.match(formatRunStatus(completed), /run_123.*completed/);
assert.match(formatRunStatus(completed), /T1.*completed.*attempts: 1/);
assert.match(formatRunStatus(completed), /dirty source: yes/);
assert.match(formatRunList([completed]), /run_123.*completed.*\/tmp\/project/);
assert.equal(formatRunList([]), "No worker runs found.");
assert.equal(await resolveLogsRun({ observeLatest: async () => undefined }), undefined);
assert.equal(
  await resolveLogsRun({
    observeLatest: async () => ({ run: completed, logs: [] }),
  }),
  "run_123",
);
