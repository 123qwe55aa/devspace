import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureWorktreeEvidence } from "./evidence.js";

const execFileAsync = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "devspace-evidence-test-"));
await git(["init"]);
await git(["config", "user.email", "devspace@example.com"]);
await git(["config", "user.name", "DevSpace Test"]);
await writeFile(join(repo, "tracked.txt"), "before\n");
await git(["add", "."]);
await git(["commit", "-m", "initial"]);
const baseSha = (await git(["rev-parse", "HEAD"])).trim();

await writeFile(join(repo, "tracked.txt"), "after\n");
await writeFile(join(repo, "new.txt"), "new\n");
const evidence = await captureWorktreeEvidence(repo, baseSha);
assert.match(evidence.trackedDiff, /tracked\.txt/);
assert.deepEqual(
  evidence.untracked.map((item) => item.path),
  ["new.txt"],
);
assert.match(evidence.untracked[0]!.sha256, /^[a-f0-9]{64}$/);
assert.match(evidence.worktreeHash, /^[a-f0-9]{64}$/);
assert.equal((await captureWorktreeEvidence(repo, baseSha)).worktreeHash, evidence.worktreeHash);
assert.equal(evidence.ignoredFilesExcluded, true);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd: repo })).stdout;
}
