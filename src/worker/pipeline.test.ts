import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "devspace-pipeline-test-")));
const project = join(root, "project");
const configDir = join(root, "config");
const worktreeRoot = join(root, "worktrees");
await mkdir(project);
await git(["init"]);
await git(["config", "user.email", "devspace@example.com"]);
await git(["config", "user.name", "DevSpace Test"]);
await writeFile(join(project, "README.md"), "base\n");
await git(["add", "."]);
await git(["commit", "-m", "initial"]);

await mkdir(join(project, ".devspace", "spec"), { recursive: true });
await writeFile(
  join(project, ".devspace", "spec", "current.json"),
  JSON.stringify({
    version: 1,
    project: "project",
    goal: "Create worker output",
    architecturePlan: { summary: "One file", modules: [] },
    tasks: [
      {
        id: "T1",
        title: "Create output",
        instruction: "Create worker-output.txt",
        files: ["worker-output.txt"],
        constraints: [],
        acceptanceCriteria: ["worker-output.txt exists"],
      },
    ],
  }),
);

const fakeCodex = join(root, "fake-codex.mjs");
await writeFile(
  fakeCodex,
  `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv.includes("--version")) {
  console.log("fake-codex 1.0");
  process.exit(0);
}
const cwd = process.argv[process.argv.indexOf("-C") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
await writeFile(join(cwd, "worker-output.txt"), prompt);
console.log("fake worker complete");
`,
);
await chmod(fakeCodex, 0o755);

const env = {
  ...process.env,
  DEVSPACE_CODEX_BIN: fakeCodex,
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_WORKTREE_ROOT: worktreeRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  PORT: "1",
};
const cli = join(process.cwd(), "src", "cli.ts");
const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const run = await execFileAsync(process.execPath, [tsxCli, cli, "run"], {
  cwd: project,
  env,
});
assert.match(run.stdout, /completed/);

const runsRoot = join(configDir, "runs");
const runId = (await readdir(runsRoot)).find((entry) => entry.startsWith("run_"));
assert.ok(runId);
const runDirectory = join(runsRoot, runId);
const projection = JSON.parse(await readFile(join(runDirectory, "run.json"), "utf8")) as {
  worktreePath: string;
};
const status = await execFileAsync(
  process.execPath,
  [tsxCli, cli, "status", runId],
  { cwd: project, env },
);
assert.match(status.stdout, new RegExp(`${runId}.*completed`));

const logs = await execFileAsync(
  process.execPath,
  [tsxCli, cli, "logs", runId],
  { cwd: project, env },
);
assert.match(logs.stdout, /==> T1 attempt 1 <==/);
assert.match(logs.stdout, /fake worker complete/);

for (const path of [
  "spec.json",
  "events.jsonl",
  "run.json",
  "tasks/T1/attempt-1.prompt.md",
  "tasks/T1/attempt-1.log",
  "tasks/T1/attempt-1.diff",
  "tasks/T1/attempt-1-fingerprint.json",
]) {
  await access(join(runDirectory, path));
}
await assert.rejects(() => access(join(runDirectory, "execution-plan.json")));
await assert.rejects(() => access(join(project, "worker-output.txt")));
await access(join(projection.worktreePath, "worker-output.txt"));
assert.match(
  await readFile(join(runDirectory, "tasks", "T1", "attempt-1-fingerprint.json"), "utf8"),
  /"model": "unknown"/,
);

async function git(args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: project });
}
