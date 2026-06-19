# Codex Worker Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `devspace run`, `devspace status`, and `devspace runs` so a ChatGPT-authored Task Spec can be executed by the local Codex CLI in an isolated managed worktree with traceable lifecycle state and execution evidence.

**Architecture:** A strict Spec loader and deterministic prompt compiler feed an abstract `WorkerBackend`; the MVP backend launches `codex exec`. A Worker orchestrator owns worktree creation and task sequencing, while an append-only event journal is the sole lifecycle-state authority and `run.json` is a disposable projection. Exact prompts, logs, fingerprints, and diffs are evidence artifacts, not replayable state.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, Git worktrees, Node child processes, existing DevSpace configuration and test conventions.

---

## File Map

### New runtime files

- `src/worker/spec.ts` — strict version 1 Task Spec schema, loader, and semantic lint.
- `src/worker/compiler.ts` — deterministic prompt compiler and prompt hashing.
- `src/worker/events.ts` — versioned lifecycle event union and pure projection reducer.
- `src/worker/run-store.ts` — run directories, JSONL journal, atomic projection, artifacts, run listing, and exclusive locks.
- `src/worker/evidence.ts` — Git-based worktree fingerprints and tracked diff evidence.
- `src/worker/backend.ts` — `WorkerBackend` contract and `CodexCliWorker` process adapter.
- `src/worker/orchestrator.ts` — new-run and resume state machine.
- `src/worker/commands.ts` — CLI-facing `run`, `status`, and `runs` presentation.
- `prompts/worker-prompt-v1.md` — immutable version 1 Worker prompt template.

### New tests

- `src/worker/spec.test.ts`
- `src/worker/compiler.test.ts`
- `src/worker/run-store.test.ts`
- `src/worker/evidence.test.ts`
- `src/worker/backend.test.ts`
- `src/worker/orchestrator.test.ts`
- `src/worker/commands.test.ts`

### Modified files

- `src/git-worktrees.ts` — export Git-root/base-SHA inspection needed before run creation.
- `src/cli.ts` — route the three Worker commands without changing existing commands.
- `package.json` — ship the prompt and include Worker tests.
- `README.md` — document the optional Worker handoff.
- `docs/chatgpt-coding-workflow.md` — document how ChatGPT writes the Spec.

## Task 1: Strict Task Spec Loading and Linting

**Files:**
- Create: `src/worker/spec.ts`
- Create: `src/worker/spec.test.ts`

- [ ] **Step 1: Write failing schema and lint tests**

Create `src/worker/spec.test.ts` with representative valid input and failures:

```ts
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
    modules: [{ name: "greeting", responsibility: "Build greetings", files: ["src/greeting.ts"] }],
  },
  tasks: [{
    id: "T1",
    title: "Implement greeting",
    instruction: "Create the greeting module.",
    files: ["src/greeting.ts"],
    constraints: ["Do not add dependencies"],
    acceptanceCriteria: ["The module exports greet"],
  }],
};

assert.equal(parseTaskSpec(valid, process.cwd()).spec.tasks[0]?.id, "T1");
assert.throws(() => parseTaskSpec({ ...valid, extra: true }, process.cwd()), /Unrecognized key/);
assert.throws(
  () => parseTaskSpec({ ...valid, tasks: [valid.tasks[0], valid.tasks[0]] }, process.cwd()),
  /duplicate task id T1/i,
);
assert.throws(
  () => parseTaskSpec({ ...valid, tasks: [{ ...valid.tasks[0], files: ["../secret"] }] }, process.cwd()),
  /project-relative/i,
);

const project = await mkdtemp(join(tmpdir(), "devspace-spec-test-"));
await mkdir(join(project, ".devspace", "spec"), { recursive: true });
await writeFile(taskSpecPath(project), JSON.stringify(valid));
const loaded = await loadTaskSpec(project);
assert.equal(loaded.spec.goal, valid.goal);
assert.match(loaded.warnings.join("\n"), /src\/greeting\.ts.*does not exist/i);
```

- [ ] **Step 2: Run the test and confirm the module is missing**

Run: `npx tsx src/worker/spec.test.ts`

Expected: FAIL with `Cannot find module './spec.js'`.

- [ ] **Step 3: Implement the strict schema and deterministic lint**

Create `src/worker/spec.ts` with these public contracts and limits:

```ts
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import * as z from "zod/v4";

const text = (max: number) => z.string().trim().min(1).max(max);
const relativeFile = text(1_000);
const moduleSchema = z.object({
  name: text(200),
  responsibility: text(2_000),
  files: z.array(relativeFile).max(100),
}).strict();
const taskSchema = z.object({
  id: text(64).regex(/^[A-Za-z0-9._-]+$/, "Task IDs may contain letters, numbers, dot, underscore, and dash"),
  title: text(200),
  instruction: text(20_000),
  files: z.array(relativeFile).max(100),
  constraints: z.array(text(2_000)).max(100),
  acceptanceCriteria: z.array(text(2_000)).max(100),
}).strict();
export const taskSpecSchema = z.object({
  version: z.literal(1),
  project: text(200),
  goal: text(20_000),
  architecturePlan: z.object({ summary: text(20_000), modules: z.array(moduleSchema).max(100) }).strict(),
  tasks: z.array(taskSchema).min(1).max(100),
}).strict();

export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type TaskSpecTask = TaskSpec["tasks"][number];
export interface LoadedTaskSpec { spec: TaskSpec; path: string; warnings: string[] }

export function taskSpecPath(projectRoot: string): string {
  return join(projectRoot, ".devspace", "spec", "current.json");
}

export function parseTaskSpec(input: unknown, projectRoot: string): Omit<LoadedTaskSpec, "path"> {
  const spec = taskSpecSchema.parse(input);
  const ids = new Set<string>();
  for (const task of spec.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id ${task.id}`);
    ids.add(task.id);
  }
  for (const path of [...spec.architecturePlan.modules.flatMap((item) => item.files), ...spec.tasks.flatMap((task) => task.files)]) {
    assertSafeRelativePath(path);
  }
  return { spec, warnings: [] };
}

export async function loadTaskSpec(projectRoot: string): Promise<LoadedTaskSpec> {
  const path = taskSpecPath(projectRoot);
  const input = JSON.parse(await readFile(path, "utf8")) as unknown;
  const parsed = parseTaskSpec(input, projectRoot);
  const warnings: string[] = [];
  for (const file of new Set(parsed.spec.tasks.flatMap((task) => task.files))) {
    if (!(await stat(join(projectRoot, file)).catch(() => undefined))) warnings.push(`${file} does not exist in the base checkout`);
  }
  return { ...parsed, path, warnings };
}

function assertSafeRelativePath(path: string): void {
  const segments = path.replaceAll("\\", "/").split("/");
  if (isAbsolute(path) || path.includes("\0") || segments.includes("..") || normalize(path).startsWith(`..${sep}`)) {
    throw new Error(`Declared file path must be project-relative: ${path}`);
  }
}
```

Ensure `parseTaskSpec` returns missing-path warnings only from `loadTaskSpec`; pure parsing must not touch the filesystem.

- [ ] **Step 4: Run the Spec test**

Run: `npx tsx src/worker/spec.test.ts`

Expected: PASS with no output.

- [ ] **Step 5: Commit the Spec boundary**

```bash
git add src/worker/spec.ts src/worker/spec.test.ts
git commit -m "feat: add worker task spec validation"
```

## Task 2: Versioned Deterministic Prompt Compiler

**Files:**
- Create: `prompts/worker-prompt-v1.md`
- Create: `src/worker/compiler.ts`
- Create: `src/worker/compiler.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing compiler test**

Create `src/worker/compiler.test.ts`:

```ts
import assert from "node:assert/strict";
import { compileTask } from "./compiler.js";
import type { TaskSpec } from "./spec.js";

const spec: TaskSpec = {
  version: 1,
  project: "sample",
  goal: "Add greeting support",
  architecturePlan: { summary: "Add one module", modules: [] },
  tasks: [{
    id: "T1",
    title: "Implement greeting",
    instruction: "Create src/greeting.ts.",
    files: ["src/greeting.ts"],
    constraints: ["No dependencies"],
    acceptanceCriteria: ["Exports greet"],
  }],
};
const first = await compileTask({ runId: "run_1", baseSha: "abc123", spec, task: spec.tasks[0]! });
const second = await compileTask({ runId: "run_1", baseSha: "abc123", spec, task: spec.tasks[0]! });
assert.equal(first.promptVersion, "worker-prompt-v1");
assert.equal(first.compilerVersion, 1);
assert.equal(first.prompt, second.prompt);
assert.equal(first.promptHash, second.promptHash);
assert.match(first.prompt, /Do not redesign the architecture/);
assert.match(first.prompt, /Create src\/greeting\.ts/);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx tsx src/worker/compiler.test.ts`

Expected: FAIL with `Cannot find module './compiler.js'`.

- [ ] **Step 3: Add the immutable prompt template**

Create `prompts/worker-prompt-v1.md`:

```markdown
You are the Codex Worker for a DevSpace run.

Execute exactly the assigned task inside the current worktree.

Rules:
- Do not redesign the architecture.
- Do not add unrelated features.
- Do not commit or push changes.
- Do not modify files outside the current worktree.
- Inspect existing code before editing.
- Stop after the assigned task is implemented.

Run: {{RUN_ID}}
Base commit: {{BASE_SHA}}
Project: {{PROJECT}}
Goal: {{GOAL}}
Architecture: {{ARCHITECTURE}}

Task {{TASK_ID}} — {{TASK_TITLE}}
Instruction:
{{TASK_INSTRUCTION}}

Expected files:
{{FILES}}

Constraints:
{{CONSTRAINTS}}

Acceptance criteria:
{{ACCEPTANCE_CRITERIA}}
```

- [ ] **Step 4: Implement deterministic compilation**

Create `src/worker/compiler.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TaskSpec, TaskSpecTask } from "./spec.js";

export const COMPILER_VERSION = 1;
export const PROMPT_VERSION = "worker-prompt-v1";
const templateUrl = new URL(`../../prompts/${PROMPT_VERSION}.md`, import.meta.url);

export interface ExecutionTask {
  runId: string;
  taskId: string;
  baseSha: string;
  compilerVersion: number;
  promptVersion: string;
  prompt: string;
  promptHash: string;
}

export async function compileTask(input: {
  runId: string;
  baseSha: string;
  spec: TaskSpec;
  task: TaskSpecTask;
}): Promise<ExecutionTask> {
  const template = await readFile(templateUrl, "utf8");
  const values: Record<string, string> = {
    RUN_ID: input.runId,
    BASE_SHA: input.baseSha,
    PROJECT: input.spec.project,
    GOAL: input.spec.goal,
    ARCHITECTURE: input.spec.architecturePlan.summary,
    TASK_ID: input.task.id,
    TASK_TITLE: input.task.title,
    TASK_INSTRUCTION: input.task.instruction,
    FILES: bullets(input.task.files),
    CONSTRAINTS: bullets(input.task.constraints),
    ACCEPTANCE_CRITERIA: bullets(input.task.acceptanceCriteria),
  };
  const prompt = Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  );
  if (/{{[A-Z_]+}}/.test(prompt)) throw new Error("Worker prompt contains unresolved placeholders");
  return {
    runId: input.runId,
    taskId: input.task.id,
    baseSha: input.baseSha,
    compilerVersion: COMPILER_VERSION,
    promptVersion: PROMPT_VERSION,
    prompt,
    promptHash: createHash("sha256").update(prompt).digest("hex"),
  };
}

function bullets(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- None specified";
}
```

- [ ] **Step 5: Ship the prompt and run the compiler test**

Add `"prompts"` to the top-level `files` array in `package.json`.

Run: `npx tsx src/worker/compiler.test.ts && npm run build`

Expected: compiler test PASS and build exits 0.

- [ ] **Step 6: Commit the compiler**

```bash
git add prompts/worker-prompt-v1.md src/worker/compiler.ts src/worker/compiler.test.ts package.json
git commit -m "feat: compile versioned worker prompts"
```

## Task 3: Event Journal, Projection, and Run Lock

**Files:**
- Create: `src/worker/events.ts`
- Create: `src/worker/run-store.ts`
- Create: `src/worker/run-store.test.ts`

- [ ] **Step 1: Write failing reducer and recovery tests**

Create `src/worker/run-store.test.ts` to cover create, append, projection rebuild, truncated final line, corruption, listing, attempt numbering, and locks:

```ts
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunStore } from "./run-store.js";

const root = await mkdtemp(join(tmpdir(), "devspace-run-store-test-"));
const store = createRunStore(root);
const created = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "abc123",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec: { version: 1, project: "p", goal: "g", architecturePlan: { summary: "a", modules: [] }, tasks: [{ id: "T1", title: "t", instruction: "i", files: [], constraints: [], acceptanceCriteria: [] }] },
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
assert.equal(created.state, "planned");
await store.append(created.id, { type: "run_started" });
await store.append(created.id, { type: "task_attempt_started", taskId: "T1", attempt: 1, promptHash: "hash", promptPath: "tasks/T1/attempt-1.prompt.md", logPath: "tasks/T1/attempt-1.log" });
assert.equal((await store.load(created.id)).tasks[0]?.state, "running");
assert.equal((await store.nextAttempt(created.id, "T1")), 2);

await appendFile(join(root, created.id, "events.jsonl"), '{"broken"');
assert.equal((await store.rebuildProjection(created.id)).state, "running");
await appendFile(join(root, created.id, "events.jsonl"), "\n{}\n");
await assert.rejects(() => store.rebuildProjection(created.id), /corrupt event/i);

const lock = await store.acquireLock(created.id);
await assert.rejects(() => store.acquireLock(created.id), /already running/i);
await lock.release();
assert.match(await readFile(join(root, created.id, "run.json"), "utf8"), /running/);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx tsx src/worker/run-store.test.ts`

Expected: FAIL with missing `run-store.js`.

- [ ] **Step 3: Define versioned events and the pure reducer**

Create `src/worker/events.ts` with a discriminated union whose common envelope is:

```ts
export type RunState = "planned" | "running" | "completed" | "failed";
export type TaskState = "pending" | "running" | "completed" | "failed";

export interface RunEventEnvelope {
  version: 1;
  sequence: number;
  runId: string;
  timestamp: string;
}

export type RunEvent = RunEventEnvelope & (
  | { type: "run_created"; sourceProject: string; baseSha: string; specPath: string; compilerVersion: number; promptVersion: string; tasks: Array<{ id: string; title: string }> }
  | { type: "worktree_created"; worktreePath: string; dirtySource: boolean }
  | { type: "run_started" }
  | { type: "task_attempt_started"; taskId: string; attempt: number; promptHash: string; promptPath: string; logPath: string }
  | { type: "task_attempt_exited"; taskId: string; attempt: number; exitCode: number | null; signal: string | null; fingerprintPath?: string; diffPath?: string; evidenceError?: string }
  | { type: "task_completed"; taskId: string; attempt: number }
  | { type: "task_failed"; taskId: string; attempt: number; message: string }
  | { type: "run_completed" }
  | { type: "run_failed"; message: string }
);

export interface RunProjection {
  id: string;
  state: RunState;
  sourceProject: string;
  baseSha: string;
  specPath: string;
  worktreePath?: string;
  dirtySource?: boolean;
  compilerVersion: number;
  promptVersion: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  tasks: Array<{ id: string; title: string; state: TaskState; attempts: number }>;
}

export function reduceRunEvents(events: RunEvent[]): RunProjection {
  // Require run_created at sequence 1, require contiguous sequences, and apply each
  // event through an exhaustive switch. Reject unknown task IDs and impossible
  // terminal-state transitions. Return a new projection without filesystem access.
}
```

Implement the exhaustive reducer in the same file. `execution-plan.json` must not appear anywhere.

- [ ] **Step 4: Implement the filesystem run store**

Create `src/worker/run-store.ts` exposing this interface:

```ts
export interface RunLock { release(): Promise<void> }
export interface CreateRunInput {
  sourceProject: string;
  baseSha: string;
  specPath: string;
  spec: TaskSpec;
  compilerVersion: number;
  promptVersion: string;
}
export interface RunStore {
  createRun(input: CreateRunInput): Promise<RunProjection>;
  append(runId: string, event: RunEventInput): Promise<RunProjection>;
  load(runId: string): Promise<RunProjection>;
  rebuildProjection(runId: string): Promise<RunProjection>;
  list(): Promise<RunProjection[]>;
  latest(): Promise<RunProjection | undefined>;
  nextAttempt(runId: string, taskId: string): Promise<number>;
  acquireLock(runId: string): Promise<RunLock>;
  writeArtifact(runId: string, relativePath: string, content: string | Uint8Array): Promise<string>;
  readSpec(runId: string): Promise<TaskSpec>;
}
```

Implementation requirements:

1. Generate IDs as `run_<UTC compact timestamp>_<8 random hex>`.
2. Write `spec.json` before the initial `run_created` event.
3. Append one JSON object plus newline per event and assign the next sequence under the run lock.
4. Atomically write `run.json` using a sibling temporary file plus `rename`.
5. Parse JSONL line by line; ignore and report only a syntactically incomplete final non-empty line. Reject malformed earlier lines, unknown events, and sequence gaps.
6. `run.json` is never read as authority: `load` reduces events, repairs a stale projection, then returns it.
7. Acquire `run.lock` with `open(..., "wx")`. Store `{ pid, createdAt }`; if it exists, use `process.kill(pid, 0)` to distinguish an active owner from a stale lock, remove only stale locks, then retry once.
8. Resolve artifact paths beneath the run directory and reject absolute paths or `..` segments.

- [ ] **Step 5: Run store tests**

Run: `npx tsx src/worker/run-store.test.ts`

Expected: PASS with no output.

- [ ] **Step 6: Commit lifecycle persistence**

```bash
git add src/worker/events.ts src/worker/run-store.ts src/worker/run-store.test.ts
git commit -m "feat: persist worker run event journals"
```

## Task 4: Worktree Evidence and Codex Backend

**Files:**
- Create: `src/worker/evidence.ts`
- Create: `src/worker/evidence.test.ts`
- Create: `src/worker/backend.ts`
- Create: `src/worker/backend.test.ts`

- [ ] **Step 1: Write failing evidence tests**

Create a temporary Git repository in `src/worker/evidence.test.ts`, commit `tracked.txt`, then modify it and add `new.txt`. Assert:

```ts
const evidence = await captureWorktreeEvidence(repo, baseSha);
assert.match(evidence.trackedDiff, /tracked\.txt/);
assert.deepEqual(evidence.untracked.map((item) => item.path), ["new.txt"]);
assert.match(evidence.untracked[0]!.sha256, /^[a-f0-9]{64}$/);
assert.match(evidence.worktreeHash, /^[a-f0-9]{64}$/);
assert.equal((await captureWorktreeEvidence(repo, baseSha)).worktreeHash, evidence.worktreeHash);
```

- [ ] **Step 2: Implement deterministic evidence capture**

Create `src/worker/evidence.ts`:

```ts
export interface WorktreeEvidence {
  formatVersion: 1;
  baseSha: string;
  worktreeHash: string;
  trackedDiff: string;
  untracked: Array<{ path: string; sha256: string }>;
  ignoredFilesExcluded: true;
}

export async function captureWorktreeEvidence(root: string, baseSha: string): Promise<WorktreeEvidence> {
  // Run `git diff --binary HEAD` and `git ls-files --others --exclude-standard -z`
  // with execFile (never a shell). Sort untracked paths, hash each regular file's
  // bytes (or symlink target), then hash the NUL-delimited tuple of format version,
  // base SHA, tracked diff bytes, paths, and content hashes.
}
```

Use the existing `git()` helper from `src/git.ts`; extend its `maxBuffer` option only if the binary diff test requires it.

- [ ] **Step 3: Run evidence tests**

Run: `npx tsx src/worker/evidence.test.ts`

Expected: PASS.

- [ ] **Step 4: Write failing backend tests with a fake executable**

Create `src/worker/backend.test.ts`. The fake executable must read stdin, append it to a capture file, print to stdout and stderr, and exit using `FAKE_CODEX_EXIT`:

```ts
const worker = new CodexCliWorker({ executable: fakeCodexPath, env: { ...process.env, CAPTURE_PATH: capturePath, FAKE_CODEX_EXIT: "0" } });
assert.match(await worker.version(), /fake-codex 1\.0/);
const result = await worker.run({
  task: compiledTask,
  cwd: repo,
  logPath,
  signal: new AbortController().signal,
});
assert.equal(result.exitCode, 0);
assert.match(await readFile(capturePath, "utf8"), /assigned task/);
assert.match(await readFile(logPath, "utf8"), /stdout message/);
```

- [ ] **Step 5: Implement `WorkerBackend` and `CodexCliWorker`**

Create `src/worker/backend.ts` with:

```ts
export interface WorkerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  executableVersion: string;
  args: string[];
}

export interface WorkerRunInput {
  task: ExecutionTask;
  cwd: string;
  logPath: string;
  signal: AbortSignal;
}

export interface WorkerBackend {
  version(): Promise<string>;
  run(input: WorkerRunInput): Promise<WorkerResult>;
}

export class CodexCliWorker implements WorkerBackend {
  // executable defaults to DEVSPACE_CODEX_BIN or "codex".
  // `version()` uses execFile(executable, ["--version"]).
  // `run()` uses spawn(executable, ["exec", "--ephemeral", "--color", "never",
  //   "--sandbox", "workspace-write", "-C", cwd, "-"], { shell: false }).
  // Write the exact prompt to stdin, pipe both stdout and stderr to logPath,
  // terminate the child on AbortSignal, and resolve a structured result on close.
}
```

Do not add `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, or shell execution. Do not record environment variables in the returned argument list.

- [ ] **Step 6: Run backend tests**

Run: `npx tsx src/worker/backend.test.ts`

Expected: PASS for exit 0 and a second assertion showing the configured non-zero exit is returned, not thrown.

- [ ] **Step 7: Commit execution evidence and backend**

```bash
git add src/worker/evidence.ts src/worker/evidence.test.ts src/worker/backend.ts src/worker/backend.test.ts
git commit -m "feat: add codex worker backend and evidence"
```

## Task 5: Worker Orchestrator and Managed Worktree Integration

**Files:**
- Modify: `src/git-worktrees.ts`
- Create: `src/worker/orchestrator.ts`
- Create: `src/worker/orchestrator.test.ts`

- [ ] **Step 1: Export source inspection without creating a worktree**

Add this API to `src/git-worktrees.ts` and cover it in `src/workspaces.test.ts` or the orchestrator test:

```ts
export interface WorktreeSource {
  sourceRoot: string;
  baseSha: string;
  dirtySource: boolean;
}

export async function inspectWorktreeSource(input: {
  sourcePath: string;
  baseRef?: string;
  config: ServerConfig;
}): Promise<WorktreeSource> {
  const sourceRoot = await resolveGitRoot(assertAllowedPath(input.sourcePath, input.config.allowedRoots), input.config.allowedRoots);
  const baseSha = await resolveBaseCommit(sourceRoot, input.baseRef ?? "HEAD");
  const dirtySource = (await git(["status", "--porcelain=v1"], sourceRoot)).trim().length > 0;
  return { sourceRoot, baseSha, dirtySource };
}
```

Refactor `createManagedWorktree` to call this function so source inspection and creation cannot drift.

- [ ] **Step 2: Write the failing orchestrator test**

Create `src/worker/orchestrator.test.ts` with a temporary configured Git project, an uncommitted `.devspace/spec/current.json`, a temporary runs root, and a fake backend:

```ts
class FakeWorker implements WorkerBackend {
  calls: string[] = [];
  constructor(private readonly failTask?: string) {}
  async version(): Promise<string> { return "fake 1"; }
  async run(input: WorkerRunInput): Promise<WorkerResult> {
    this.calls.push(input.task.taskId);
    await writeFile(join(input.cwd, `${input.task.taskId}.txt`), input.task.promptHash);
    await writeFile(input.logPath, `ran ${input.task.taskId}\n`);
    return { exitCode: input.task.taskId === this.failTask ? 2 : 0, signal: null, executableVersion: "fake 1", args: ["exec"] };
  }
}
```

Assertions must prove:

1. `startNewRun()` snapshots an uncommitted Spec and creates a detached worktree at the source `HEAD`.
2. Tasks run in Spec order and share the same worktree.
3. A failed task stops later tasks and records `failed`.
4. `resumeRun(runId)` skips completed tasks and assigns attempt 2 to the failed task.
5. A second `startNewRun()` creates a different worktree and a new run ID.

- [ ] **Step 3: Run the orchestrator test and verify failure**

Run: `npx tsx src/worker/orchestrator.test.ts`

Expected: FAIL with missing `orchestrator.js`.

- [ ] **Step 4: Implement the orchestrator**

Create `src/worker/orchestrator.ts` with dependency injection:

```ts
export interface WorkerOrchestratorDependencies {
  config: ServerConfig;
  store: RunStore;
  backend: WorkerBackend;
  now?: () => Date;
}

export class WorkerOrchestrator {
  constructor(private readonly dependencies: WorkerOrchestratorDependencies) {}
  async startNewRun(projectPath: string, signal = new AbortController().signal): Promise<RunProjection>;
  async resumeRun(runId: string, signal = new AbortController().signal): Promise<RunProjection>;
}
```

`startNewRun` must execute this order:

1. Resolve and inspect the source repo.
2. Load/lint the Spec and print warnings through a returned result or injected reporter.
3. Verify the backend before run creation by obtaining the Codex version.
4. Create the run with the Spec snapshot, base SHA, compiler version, and prompt version.
5. Acquire the lock, create the managed worktree at the exact base SHA, append `worktree_created` and `run_started`, then execute pending tasks.

`resumeRun` must load the Spec snapshot from the run store, validate the existing worktree path, acquire the lock, append `run_started`, and execute only non-completed tasks. For each attempt:

1. Compile the task from the immutable snapshot.
2. Write the exact prompt artifact.
3. Capture pre-attempt evidence.
4. Append `task_attempt_started`.
5. Call `WorkerBackend.run`.
6. Capture post-attempt evidence; write the tracked diff and fingerprint JSON.
7. Append `task_attempt_exited`.
8. Append `task_completed`, or append `task_failed` and `run_failed` and stop.

Wrap execution in `try/catch/finally`; convert worktree/backend/evidence failures to `run_failed` when a run exists, preserve artifacts, and always release the lock. Never remove the worktree.

- [ ] **Step 5: Run orchestrator and existing worktree tests**

Run: `npx tsx src/worker/orchestrator.test.ts && npx tsx src/workspaces.test.ts`

Expected: both PASS.

- [ ] **Step 6: Commit orchestration**

```bash
git add src/git-worktrees.ts src/workspaces.test.ts src/worker/orchestrator.ts src/worker/orchestrator.test.ts
git commit -m "feat: orchestrate codex tasks in worktrees"
```

## Task 6: CLI Commands and Status Presentation

**Files:**
- Create: `src/worker/commands.ts`
- Create: `src/worker/commands.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing command tests**

Create `src/worker/commands.test.ts` with a fake orchestrator and store. Verify:

```ts
assert.deepEqual(parseWorkerCommand("run", []), { kind: "run-new" });
assert.deepEqual(parseWorkerCommand("run", ["run_123"]), { kind: "run-resume", runId: "run_123" });
assert.deepEqual(parseWorkerCommand("status", []), { kind: "status-latest" });
assert.deepEqual(parseWorkerCommand("status", ["run_123"]), { kind: "status", runId: "run_123" });
assert.deepEqual(parseWorkerCommand("runs", []), { kind: "runs" });
assert.throws(() => parseWorkerCommand("runs", ["extra"]), /does not accept arguments/);
assert.match(formatRunStatus(completedProjection), /completed/);
assert.match(formatRunStatus(completedProjection), /T1.*completed/);
```

- [ ] **Step 2: Implement CLI-facing commands**

Create `src/worker/commands.ts` exporting:

```ts
export type WorkerCliCommand =
  | { kind: "run-new" }
  | { kind: "run-resume"; runId: string }
  | { kind: "status-latest" }
  | { kind: "status"; runId: string }
  | { kind: "runs" };

export function parseWorkerCommand(command: "run" | "status" | "runs", args: string[]): WorkerCliCommand;
export function formatRunStatus(run: RunProjection): string;
export function formatRunList(runs: RunProjection[]): string;
export async function executeWorkerCommand(input: {
  command: WorkerCliCommand;
  cwd: string;
  config: ServerConfig;
  runsRoot: string;
  output?: Pick<NodeJS.WriteStream, "write">;
}): Promise<void>;
```

Construct `RunStore`, `CodexCliWorker`, and `WorkerOrchestrator` only inside `executeWorkerCommand`. Derive `runsRoot` as `join(loadDevspaceFiles().dir, "runs")` in `src/cli.ts`, so runtime state matches `~/.devspace/runs` and tests can redirect it with `DEVSPACE_CONFIG_DIR`.

- [ ] **Step 3: Route commands from the existing CLI**

Update `src/cli.ts`:

```ts
type Command = "serve" | "init" | "doctor" | "config" | "run" | "status" | "runs" | "help";
```

Add exact cases before `help`:

```ts
case "run":
case "status":
case "runs": {
  await ensureConfigured();
  const { executeWorkerCommand, parseWorkerCommand } = await import("./worker/commands.js");
  const files = loadDevspaceFiles();
  await executeWorkerCommand({
    command: parseWorkerCommand(command, args),
    cwd: process.cwd(),
    config: loadConfig(),
    runsRoot: resolve(files.dir, "runs"),
  });
  return;
}
```

Extend `normalizeCommand` and `printHelp` with:

```text
devspace run              Run .devspace/spec/current.json in a new worktree
devspace run <run-id>     Resume an incomplete run in its existing worktree
devspace status [run-id]  Show one run; defaults to the latest
devspace runs             List recent runs
```

- [ ] **Step 4: Run command and CLI build tests**

Run: `npx tsx src/worker/commands.test.ts && npm run typecheck && npm run build && node dist/cli.js --help`

Expected: tests/typecheck/build PASS and help displays all three commands.

- [ ] **Step 5: Commit CLI integration**

```bash
git add src/worker/commands.ts src/worker/commands.test.ts src/cli.ts
git commit -m "feat: expose worker pipeline CLI commands"
```

## Task 7: End-to-End Fake Codex Test, Package Suite, and Documentation

**Files:**
- Create: `src/worker/pipeline.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/chatgpt-coding-workflow.md`

- [ ] **Step 1: Write an end-to-end fake Codex test**

Create `src/worker/pipeline.test.ts` that:

1. Creates a temporary config directory, allowed project root, runs root, and worktree root.
2. Initializes a Git project with one commit.
3. Writes `.devspace/spec/current.json` after the commit.
4. Writes an executable fake Codex program that supports both `--version` and `exec`, reads the prompt from stdin, and creates `worker-output.txt` in the `-C` directory.
5. Spawns the built CLI with `DEVSPACE_CODEX_BIN`, `DEVSPACE_CONFIG_DIR`, `DEVSPACE_ALLOWED_ROOTS`, `DEVSPACE_WORKTREE_ROOT`, and a test owner token.
6. Asserts `devspace run` exits 0 and prints a run ID and worktree path.
7. Asserts `devspace status <run-id>` reports `completed`.
8. Asserts the run directory contains `spec.json`, `events.jsonl`, `run.json`, prompt, log, fingerprint, and diff artifacts, and does not contain `execution-plan.json`.
9. Asserts the source checkout does not contain `worker-output.txt`, while the managed worktree does.

- [ ] **Step 2: Add all Worker tests to the package suite**

Append these commands to the existing `test` script in `package.json`:

```json
"tsx src/worker/spec.test.ts && tsx src/worker/compiler.test.ts && tsx src/worker/run-store.test.ts && tsx src/worker/evidence.test.ts && tsx src/worker/backend.test.ts && tsx src/worker/orchestrator.test.ts && tsx src/worker/commands.test.ts && tsx src/worker/pipeline.test.ts"
```

Keep all existing test commands.

- [ ] **Step 3: Document the optional Worker workflow**

Add a concise README section after “What ChatGPT Can Do”:

```markdown
## Optional Codex Worker Pipeline

ChatGPT can hand a structured task to the local Codex CLI without changing the normal MCP workflow:

1. Ask ChatGPT to inspect the project and write `.devspace/spec/current.json`.
2. Review the JSON.
3. Run `devspace run` from the project checkout.
4. Inspect the isolated result with `devspace status`.

DevSpace creates a detached managed worktree and never commits or pushes Worker changes. A resumed run continues the same mutable worktree; it is recovery, not deterministic replay.
```

Extend `docs/chatgpt-coding-workflow.md` with the version 1 JSON contract, the exact three CLI commands, the warning that uncommitted source files other than the Spec are not copied, and the traceability-not-replay boundary.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

Expected:

- every existing and new test exits 0;
- TypeScript reports no errors;
- Vite and TypeScript build successfully;
- package dry-run lists `prompts/worker-prompt-v1.md` and compiled Worker modules.

- [ ] **Step 5: Inspect the final diff and forbidden artifacts**

Run:

```bash
git diff --check
rg -n "execution-plan\.json|deterministic replay|replayable execution" src prompts README.md docs/chatgpt-coding-workflow.md
git status --short
```

Expected: `git diff --check` is silent; the search finds only deliberate documentation rejecting deterministic replay and the test asserting that `execution-plan.json` is absent; status contains only intended files.

- [ ] **Step 6: Commit the tested MVP**

```bash
git add package.json README.md docs/chatgpt-coding-workflow.md src/worker/pipeline.test.ts
git commit -m "test: verify worker pipeline end to end"
```

## Final Acceptance Check

- [ ] Existing MCP server commands and tests remain unchanged in behavior.
- [ ] `devspace run` reads only `.devspace/spec/current.json` for a new run.
- [ ] New runs snapshot the Spec and source base SHA before creating a worktree.
- [ ] Resume uses the immutable snapshot and existing worktree, skips completed tasks, and creates a new attempt.
- [ ] The Task Compiler is deterministic; Worker execution is explicitly non-deterministic.
- [ ] `events.jsonl` is the only lifecycle-state authority and `run.json` is rebuildable.
- [ ] No `execution-plan.json` exists.
- [ ] Prompt, log, fingerprint, and diff artifacts are evidence, not state.
- [ ] Codex receives `workspace-write` access only to the managed worktree.
- [ ] DevSpace does not run target-project verification, commit, push, retry automatically, or expose Worker MCP tools.
