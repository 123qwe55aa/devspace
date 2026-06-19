import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaskSpec, parseTaskSpec, taskSpecPath } from "./spec.js";

const valid = {
  version: 1,
  project: "sample",
  goal: "Add greeting support",
  architecturePlan: {
    summary: "Add one focused module",
    modules: [
      {
        name: "greeting",
        responsibility: "Build greetings",
        files: ["src/greeting.ts"],
      },
    ],
  },
  tasks: [
    {
      id: "T1",
      title: "Implement greeting",
      instruction: "Create the greeting module.",
      files: ["src/greeting.ts"],
      constraints: ["Do not add dependencies"],
      acceptanceCriteria: ["The module exports greet"],
    },
  ],
};

assert.equal(parseTaskSpec(valid).tasks[0]?.id, "T1");
assert.throws(() => parseTaskSpec({ ...valid, extra: true }));
assert.throws(
  () => parseTaskSpec({ ...valid, tasks: [valid.tasks[0], valid.tasks[0]] }),
  /duplicate task id T1/i,
);
assert.throws(
  () =>
    parseTaskSpec({
      ...valid,
      tasks: [{ ...valid.tasks[0], files: ["../secret"] }],
    }),
  /project-relative/i,
);
assert.throws(
  () => parseTaskSpec({ ...valid, tasks: [{ ...valid.tasks[0], id: "unsafe/id" }] }),
  /letters, numbers/i,
);

const project = await mkdtemp(join(tmpdir(), "devspace-spec-test-"));
await mkdir(join(project, ".devspace", "spec"), { recursive: true });
await writeFile(taskSpecPath(project), JSON.stringify(valid));
const loaded = await loadTaskSpec(project);
assert.equal(loaded.spec.goal, valid.goal);
assert.match(loaded.warnings.join("\n"), /src\/greeting\.ts.*does not exist/i);
