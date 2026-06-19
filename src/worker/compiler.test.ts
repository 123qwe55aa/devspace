import assert from "node:assert/strict";
import { compileTask } from "./compiler.js";
import type { TaskSpec } from "./spec.js";

const spec: TaskSpec = {
  version: 1,
  project: "sample",
  goal: "Add greeting support",
  architecturePlan: { summary: "Add one module", modules: [] },
  tasks: [
    {
      id: "T1",
      title: "Implement greeting",
      instruction: "Create src/greeting.ts.",
      files: ["src/greeting.ts"],
      constraints: ["No dependencies"],
      acceptanceCriteria: ["Exports greet"],
    },
  ],
};

const first = await compileTask({
  runId: "run_1",
  baseSha: "abc123",
  spec,
  task: spec.tasks[0]!,
});
const second = await compileTask({
  runId: "run_1",
  baseSha: "abc123",
  spec,
  task: spec.tasks[0]!,
});

assert.equal(first.promptVersion, "worker-prompt-v1");
assert.equal(first.compilerVersion, 1);
assert.equal(first.prompt, second.prompt);
assert.equal(first.promptHash, second.promptHash);
assert.match(first.promptHash, /^[a-f0-9]{64}$/);
assert.match(first.prompt, /Do not redesign the architecture/);
assert.match(first.prompt, /Create src\/greeting\.ts/);
assert.doesNotMatch(first.prompt, /{{[A-Z_]+}}/);
