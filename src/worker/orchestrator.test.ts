import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import type { WorkerBackend, WorkerResult, WorkerRunInput } from "./backend.js";
import { WorkerOrchestrator } from "./orchestrator.js";
import { createRunStore } from "./run-store.js";

const execFileAsync = promisify(execFile);

class FakeWorker implements WorkerBackend {
  readonly calls: string[] = [];
  private failed = false;

  constructor(private readonly failOnceTask?: string) {}

  async version(): Promise<string> {
    return "fake-codex 1.0";
  }

  async run(input: WorkerRunInput): Promise<WorkerResult> {
    this.calls.push(input.task.taskId);
    await writeFile(join(input.cwd, `${input.task.taskId}.txt`), input.task.promptHash);
    await writeFile(input.logPath, `ran ${input.task.taskId}\n`);
    const shouldFail = input.task.taskId === this.failOnceTask && !this.failed;
    if (shouldFail) this.failed = true;
    return {
      exitCode: shouldFail ? 2 : 0,
      signal: null,
      executableVersion: "fake-codex 1.0",
      args: ["exec"],
    };
  }
}

const root = await mkdtemp(join(tmpdir(), "devspace-orchestrator-test-"));
const project = join(root, "project");
await mkdir(project);
await git(project, ["init"]);
await git(project, ["config", "user.email", "devspace@example.com"]);
await git(project, ["config", "user.name", "DevSpace Test"]);
await writeFile(join(project, "README.md"), "base\n");
await git(project, ["add", "."]);
await git(project, ["commit", "-m", "initial"]);

const specDirectory = join(project, ".devspace", "spec");
await mkdir(specDirectory, { recursive: true });
await writeFile(
  join(specDirectory, "current.json"),
  JSON.stringify({
    version: 1,
    project: "project",
    goal: "Create two files",
    architecturePlan: { summary: "Two sequential tasks", modules: [] },
    tasks: [
      {
        id: "T1",
        title: "First",
        instruction: "Create T1.txt",
        files: ["T1.txt"],
        constraints: [],
        acceptanceCriteria: ["T1.txt exists"],
      },
      {
        id: "T2",
        title: "Second",
        instruction: "Create T2.txt",
        files: ["T2.txt"],
        constraints: [],
        acceptanceCriteria: ["T2.txt exists"],
      },
    ],
  }),
);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_WORKTREE_ROOT: join(root, "worktrees"),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  PORT: "1",
});
const store = createRunStore(join(root, "runs"));
const worker = new FakeWorker("T2");
const orchestrator = new WorkerOrchestrator({ config, store, backend: worker });

const failed = await orchestrator.startNewRun(project);
assert.equal(failed.state, "failed");
assert.deepEqual(worker.calls, ["T1", "T2"]);
assert.equal(failed.tasks[0]?.state, "completed");
assert.equal(failed.tasks[1]?.attempts, 1);
assert.ok(failed.worktreePath);
await access(join(failed.worktreePath!, "T1.txt"));
await access(join(failed.worktreePath!, "T2.txt"));
await assert.rejects(() => access(join(project, "T1.txt")));

const resumed = await orchestrator.resumeRun(failed.id);
assert.equal(resumed.state, "completed");
assert.deepEqual(worker.calls, ["T1", "T2", "T2"]);
assert.equal(resumed.tasks[0]?.attempts, 1);
assert.equal(resumed.tasks[1]?.attempts, 2);

const fresh = await orchestrator.startNewRun(project);
assert.equal(fresh.state, "completed");
assert.notEqual(fresh.id, resumed.id);
assert.notEqual(fresh.worktreePath, resumed.worktreePath);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
