# Worker Logs Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `devspace logs [run-id]`, a read-only follower that prints existing raw Codex output, follows appended bytes, advances across task attempts, and exits with the run.

**Architecture:** Extend the file-backed run store with a read-only observation API that returns a validated projection plus safely resolved task-attempt log artifacts. Put polling, byte offsets, UTF-8 decoding, task switching, and cancellation in a focused `log-follower.ts` module; keep `commands.ts` responsible only for parsing and wiring CLI dependencies.

**Tech Stack:** TypeScript ESM, Node.js filesystem APIs, `node:string_decoder`, Zod-validated event journals, assertion-style tests executed with `tsx`.

---

## File Map

- Modify `src/worker/run-store.ts`: expose read-only run observations and validated attempt-log paths without updating `run.json`.
- Modify `src/worker/run-store.test.ts`: prove observation is read-only and rejects escaping artifact paths.
- Create `src/worker/log-follower.ts`: follow attempt logs with byte offsets, UTF-8-safe decoding, polling, switching, and cancellation.
- Create `src/worker/log-follower.test.ts`: deterministic follower behavior tests using an injected polling wait.
- Modify `src/worker/commands.ts`: parse and execute `logs` commands.
- Modify `src/worker/commands.test.ts`: cover `logs` parsing and command wiring.
- Modify `src/cli.ts`: route `logs` and document it in help.
- Modify `src/worker/pipeline.test.ts`: verify completed-run logs through the real CLI boundary.
- Modify `package.json`: include the new test file in `npm test`.
- Modify `README.md` and `docs/chatgpt-coding-workflow.md`: document background-run observation.

### Task 1: Read-only run observation

**Files:**
- Modify: `src/worker/run-store.ts`
- Test: `src/worker/run-store.test.ts`

- [ ] **Step 1: Write failing observation tests**

Add imports for `stat` and `resolve`, then append tests that require observation to return validated task-attempt logs, avoid rewriting `run.json`, and reject an escaping path from a syntactically valid event:

```ts
const projectionPath = join(root, created.id, "run.json");
await writeFile(projectionPath, "sentinel\n");
const observed = await store.observe(created.id);
assert.equal(observed.run.tasks[0]?.state, "running");
assert.deepEqual(observed.logs, [{
  taskId: "T1",
  attempt: 1,
  path: resolve(root, created.id, "tasks/T1/attempt-1.log"),
}]);
assert.equal(await readFile(projectionPath, "utf8"), "sentinel\n");
assert.equal((await store.observeLatest())?.run.id, created.id);
assert.equal(await readFile(projectionPath, "utf8"), "sentinel\n");

const escaped = await store.createRun({
  sourceProject: "/tmp/project",
  baseSha: "escape",
  specPath: "/tmp/project/.devspace/spec/current.json",
  spec,
  compilerVersion: 1,
  promptVersion: "worker-prompt-v1",
});
await store.append(escaped.id, { type: "run_started" });
await store.append(escaped.id, {
  type: "task_attempt_started",
  taskId: "T1",
  attempt: 1,
  promptHash: "hash",
  promptPath: "tasks/T1/attempt-1.prompt.md",
  logPath: "../outside.log",
});
await assert.rejects(() => store.observe(escaped.id), /inside the run directory/i);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npx tsx src/worker/run-store.test.ts
```

Expected: TypeScript/runtime failure because `RunStore.observe` does not exist.

- [ ] **Step 3: Add the minimal observation API**

Add focused public types and method:

```ts
export interface RunAttemptLog {
  taskId: string;
  attempt: number;
  path: string;
}

export interface RunObservation {
  run: RunProjection;
  logs: RunAttemptLog[];
}

export interface RunStore {
  observe(runId: string): Promise<RunObservation>;
  observeLatest(): Promise<RunObservation | undefined>;
}
```

Implement it from validated events without calling `writeProjection`:

```ts
async observe(runId: string): Promise<RunObservation> {
  const events = await this.readEvents(runId);
  return {
    run: reduceRunEvents(events),
    logs: events
      .filter((event) => event.type === "task_attempt_started")
      .map((event) => ({
        taskId: event.taskId,
        attempt: event.attempt,
        path: this.resolveArtifactPath(runId, event.logPath),
      })),
  };
}

async observeLatest(): Promise<RunObservation | undefined> {
  const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
  const runId = entries
    .filter((entry) => entry.isDirectory() && /^run_[A-Za-z0-9_-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))[0];
  return runId ? this.observe(runId) : undefined;
}
```

Extract path validation so both `writeArtifact` and observation use the same boundary:

```ts
private resolveArtifactPath(runId: string, relativePath: string): string {
  const runDirectory = this.runDirectory(runId);
  const path = resolve(runDirectory, relativePath);
  const relationship = relative(runDirectory, path);
  if (
    isAbsolute(relativePath) ||
    relationship === ".." ||
    relationship.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)
  ) {
    throw new Error(`Artifact path must stay inside the run directory: ${relativePath}`);
  }
  return path;
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run the Task 1 command again. Expected: exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/worker/run-store.ts src/worker/run-store.test.ts
git commit -m "feat: expose read-only worker run observations"
```

### Task 2: Polling log follower

**Files:**
- Create: `src/worker/log-follower.ts`
- Create: `src/worker/log-follower.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing follower test**

Create a temporary run with two tasks and a controllable `wait` callback. The callback appends a split UTF-8 character, completes T1, starts T2 before its file exists, then writes T2 and completes the run. Assert headers, exact content, no duplicate bytes, and no projection writes:

```ts
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
    } else if (step === 2) {
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
    } else {
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
    }
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
```

Add `tsx src/worker/log-follower.test.ts` immediately after `run-store.test.ts` in the `test` script.

- [ ] **Step 2: Run the follower test and verify RED**

Run:

```bash
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npx tsx src/worker/log-follower.test.ts
```

Expected: module-not-found for `./log-follower.js`.

- [ ] **Step 3: Implement the minimal follower**

Define a small dependency-injected API:

```ts
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { RunStore } from "./run-store.js";

interface LogCursor {
  offset: number;
  identity?: string;
  decoder: StringDecoder;
  announced: boolean;
}

export interface FollowRunLogsInput {
  store: RunStore;
  runId: string;
  output: { write(chunk: string): unknown };
  signal?: AbortSignal;
  pollIntervalMs?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export async function followRunLogs(input: FollowRunLogsInput): Promise<void> {
  const interval = input.pollIntervalMs ?? 250;
  const wait = input.wait ?? abortableDelay;
  const cursors = new Map<string, LogCursor>();
  while (!input.signal?.aborted) {
    const observation = await input.store.observe(input.runId);
    for (const log of observation.logs) {
      const key = `${log.taskId}:${log.attempt}`;
      let cursor = cursors.get(key);
      if (!cursor) {
        cursor = { offset: 0, decoder: new StringDecoder("utf8"), announced: false };
        cursors.set(key, cursor);
      }
      const metadata = await stat(log.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!metadata) continue;
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (cursor.identity !== undefined && (cursor.identity !== identity || metadata.size < cursor.offset)) {
        input.output.write(cursor.decoder.end());
        cursor = { offset: 0, identity, decoder: new StringDecoder("utf8"), announced: cursor.announced };
        cursors.set(key, cursor);
      }
      cursor.identity = identity;
      if (!cursor.announced) {
        input.output.write(`==> ${log.taskId} attempt ${log.attempt} <==\n`);
        cursor.announced = true;
      }
      if (metadata.size > cursor.offset) {
        const handle = await open(log.path, "r");
        try {
          const chunk = Buffer.alloc(metadata.size - cursor.offset);
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor.offset);
          cursor.offset += bytesRead;
          input.output.write(cursor.decoder.write(chunk.subarray(0, bytesRead)));
        } finally {
          await handle.close();
        }
      }
    }
    if (observation.run.state === "completed" || observation.run.state === "failed") {
      for (const cursor of cursors.values()) input.output.write(cursor.decoder.end());
      return;
    }
    await wait(interval, input.signal);
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
```

Use `FileHandle.read` with Buffer offsets rather than `readFile(..., "utf8")`. Use `StringDecoder.write` for each appended Buffer and `decoder.end()` only when an attempt is known to have ended or the run is terminal. Implement the default wait with an abort listener that clears its timer before resolving.

- [ ] **Step 4: Run follower tests and verify GREEN**

Run the Task 2 command. Expected: exit 0 with no output.

- [ ] **Step 5: Run store and follower regression tests**

```bash
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npx tsx src/worker/run-store.test.ts
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npx tsx src/worker/log-follower.test.ts
```

Expected: both exit 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add package.json src/worker/log-follower.ts src/worker/log-follower.test.ts
git commit -m "feat: follow worker task logs"
```

### Task 3: CLI parsing and command execution

**Files:**
- Modify: `src/worker/commands.ts`
- Test: `src/worker/commands.test.ts`

- [ ] **Step 1: Write failing command tests**

Extend parser assertions:

```ts
assert.deepEqual(parseWorkerCommand("logs", []), { kind: "logs-latest" });
assert.deepEqual(parseWorkerCommand("logs", ["run_123"]), {
  kind: "logs",
  runId: "run_123",
});
assert.throws(() => parseWorkerCommand("logs", ["one", "two"]), /at most one run id/);
```

Extract a `resolveLogsRun` helper and test the no-runs behavior without constructing a real `CodexCliWorker`:

```ts
assert.equal(await resolveLogsRun({ observeLatest: async () => undefined }), undefined);
assert.equal(
  await resolveLogsRun({
    observeLatest: async () => ({ run: completed, logs: [] }),
  }),
  "run_123",
);
```

- [ ] **Step 2: Run command tests and verify RED**

```bash
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npx tsx src/worker/commands.test.ts
```

Expected: type/parser failures because `logs` is unsupported.

- [ ] **Step 3: Implement parsing and execution wiring**

Extend command types and parser input:

```ts
export type WorkerCliCommand =
  | { kind: "run-new" }
  | { kind: "run-resume"; runId: string }
  | { kind: "status-latest" }
  | { kind: "status"; runId: string }
  | { kind: "runs" }
  | { kind: "logs-latest" }
  | { kind: "logs"; runId: string };

export function parseWorkerCommand(
  command: "run" | "status" | "runs" | "logs",
  args: string[],
): WorkerCliCommand {
  if (command === "runs") {
    if (args.length > 0) throw new Error("`devspace runs` does not accept arguments");
    return { kind: "runs" };
  }
  if (args.length > 1) throw new Error(`\`devspace ${command}\` accepts at most one run id`);
  if (command === "run") {
    return args[0] ? { kind: "run-resume", runId: args[0] } : { kind: "run-new" };
  }
  if (command === "logs") {
    return args[0] ? { kind: "logs", runId: args[0] } : { kind: "logs-latest" };
  }
  return args[0] ? { kind: "status", runId: args[0] } : { kind: "status-latest" };
}

export async function resolveLogsRun(
  store: Pick<RunStore, "observeLatest">,
): Promise<string | undefined> {
  return (await store.observeLatest())?.run.id;
}
```

For `logs-latest`, call `store.observeLatest()` to select the ID without rebuilding `run.json`, print `No worker runs found.` if absent, then call `followRunLogs`. For `logs`, call it directly. Pass `input.signal` and `output`. Do not acquire a run lock and do not call the orchestrator.

- [ ] **Step 4: Run command tests and verify GREEN**

Run the Task 3 test command. Expected: exit 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/worker/commands.ts src/worker/commands.test.ts
git commit -m "feat: expose worker logs command"
```

### Task 4: Top-level CLI and end-to-end verification

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/worker/pipeline.test.ts`

- [ ] **Step 1: Add a failing pipeline assertion**

After the existing status assertion, invoke logs against the completed run:

```ts
const logs = await execFileAsync(
  process.execPath,
  [tsxCli, cli, "logs", runId],
  { cwd: project, env },
);
assert.match(logs.stdout, /==> T1 attempt 1 <==/);
assert.match(logs.stdout, /fake worker complete/);
```

- [ ] **Step 2: Run pipeline test and verify RED**

```bash
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npx tsx src/worker/pipeline.test.ts
```

Expected: CLI exits non-zero with `Unknown command: logs`.

- [ ] **Step 3: Route and document the top-level command**

Extend `Command`, `normalizeCommand`, and the worker-command switch group with `logs`. Add this help line:

```ts
"  devspace logs [run-id]    Follow raw Codex logs; defaults to the latest run",
```

- [ ] **Step 4: Run pipeline test and verify GREEN**

Run the Task 4 test command. Expected: exit 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/cli.ts src/worker/pipeline.test.ts
git commit -m "feat: wire worker logs into devspace cli"
```

### Task 5: User documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/chatgpt-coding-workflow.md`

- [ ] **Step 1: Document background observation**

Add the command beside `run/status/runs` in both documents:

```bash
devspace logs
devspace logs run_20260620030807262_f1a578f9
```

State that logs follows the latest or selected run, switches tasks automatically, exits at terminal state, and `Ctrl+C` stops viewing without cancelling the Worker.

- [ ] **Step 2: Run formatting and type checks**

```bash
git diff --check
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 3: Run the complete test suite**

```bash
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npm test
```

Expected: exit 0, including `log-follower.test.ts` and `pipeline.test.ts`.

- [ ] **Step 4: Build the distributable CLI**

```bash
PATH=/Users/toby/.nvm/versions/node/v24.14.0/bin:$PATH npm run build
node dist/cli.js --help | grep "devspace logs"
```

Expected: build exits 0 and help contains the logs command.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/chatgpt-coding-workflow.md
git commit -m "docs: explain worker log following"
```

- [ ] **Step 6: Review final branch state**

```bash
git status --short
git log --oneline --decorate -6
```

Expected: clean worktree with the design commit, plan commit, and four focused implementation commits.
