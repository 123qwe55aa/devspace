import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git.js";

export interface WorktreeEvidence {
  formatVersion: 1;
  baseSha: string;
  worktreeHash: string;
  trackedDiff: string;
  untracked: Array<{ path: string; sha256: string }>;
  ignoredFilesExcluded: true;
}

export async function captureWorktreeEvidence(
  root: string,
  baseSha: string,
): Promise<WorktreeEvidence> {
  const trackedDiff = (
    await git(root, ["diff", "--binary", "HEAD"], { maxBuffer: 100 * 1024 * 1024 })
  ).stdout;
  const untrackedOutput = (
    await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
      maxBuffer: 100 * 1024 * 1024,
    })
  ).stdout;
  const paths = untrackedOutput.split("\0").filter(Boolean).sort();
  const untracked: Array<{ path: string; sha256: string }> = [];

  for (const path of paths) {
    const absolutePath = join(root, path);
    const stats = await lstat(absolutePath);
    const content = stats.isSymbolicLink()
      ? Buffer.from(await readlink(absolutePath))
      : await readFile(absolutePath);
    untracked.push({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  const digest = createHash("sha256");
  digest.update("1\0");
  digest.update(baseSha);
  digest.update("\0");
  digest.update(trackedDiff);
  digest.update("\0");
  for (const file of untracked) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }

  return {
    formatVersion: 1,
    baseSha,
    worktreeHash: digest.digest("hex"),
    trackedDiff,
    untracked,
    ignoredFilesExcluded: true,
  };
}
