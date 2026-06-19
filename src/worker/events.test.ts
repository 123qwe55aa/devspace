import assert from "node:assert/strict";
import { reduceRunEvents, runEventSchema, type RunEvent, type RunEventData } from "./events.js";

const runId = "run_events";
const created = event(1, {
  type: "run_created",
  sourceProject: "/tmp/project",
  baseSha: "abc123",
  specPath: "/tmp/spec.json",
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
  tasks: [{ id: "T1", title: "Task" }],
});
const started = event(2, { type: "run_started" });
const attempt = event(3, {
  type: "task_attempt_started",
  taskId: "T1",
  attempt: 1,
  promptHash: "hash",
  promptPath: "prompt",
  logPath: "log",
});
const exited = event(4, {
  type: "task_attempt_exited",
  taskId: "T1",
  attempt: 1,
  exitCode: 0,
  signal: null,
});
const completed = event(5, { type: "task_completed", taskId: "T1", attempt: 1 });
const runCompleted = event(6, { type: "run_completed" });

assert.equal(reduceRunEvents([created, started, attempt, exited, completed, runCompleted]).state, "completed");
assert.throws(
  () => reduceRunEvents([created, event(2, {
    type: "task_attempt_started",
    taskId: "T1",
    attempt: 1,
    promptHash: "hash",
    promptPath: "prompt",
    logPath: "log",
  })]),
  /running run/i,
);
assert.throws(
  () => reduceRunEvents([created, started, attempt, event(4, { type: "task_completed", taskId: "T1", attempt: 1 })]),
  /exit/i,
);
assert.throws(
  () => reduceRunEvents([created, started, attempt, exited, event(5, {
    type: "task_attempt_exited",
    taskId: "T1",
    attempt: 1,
    exitCode: 0,
    signal: null,
  })]),
  /duplicate exit/i,
);
assert.throws(
  () => reduceRunEvents([
    created,
    started,
    attempt,
    exited,
    completed,
    runCompleted,
    event(7, { type: "run_failed", message: "late" }),
  ]),
  /terminal/i,
);

function event(sequence: number, data: RunEventData): RunEvent {
  return runEventSchema.parse({
    ...data,
    version: 1,
    sequence,
    runId,
    timestamp: `2026-06-19T00:00:0${sequence}.000Z`,
  });
}
