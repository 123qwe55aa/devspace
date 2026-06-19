import { stat } from "node:fs/promises";
import type { ServerConfig } from "../config.js";
import { createManagedWorktree, inspectWorktreeSource } from "../git-worktrees.js";
import type { WorkerBackend, WorkerResult } from "./backend.js";
import { COMPILER_VERSION, PROMPT_VERSION, compileTask } from "./compiler.js";
import { captureWorktreeEvidence } from "./evidence.js";
import type { RunProjection } from "./events.js";
import type { RunLock, RunStore } from "./run-store.js";
import { loadTaskSpec, type TaskSpec, type TaskSpecTask } from "./spec.js";

export interface WorkerOrchestratorDependencies {
  config: ServerConfig;
  store: RunStore;
  backend: WorkerBackend;
  onWarning?: (warning: string) => void;
}

export class WorkerOrchestrator {
  constructor(private readonly dependencies: WorkerOrchestratorDependencies) {}

  async startNewRun(
    projectPath: string,
    signal = new AbortController().signal,
  ): Promise<RunProjection> {
    const source = await inspectWorktreeSource({
      sourcePath: projectPath,
      config: this.dependencies.config,
    });
    const loaded = await loadTaskSpec(source.sourceRoot);
    loaded.warnings.forEach((warning) => this.dependencies.onWarning?.(warning));
    await this.dependencies.backend.version();
    const created = await this.dependencies.store.createRun({
      sourceProject: source.sourceRoot,
      baseSha: source.baseSha,
      specPath: loaded.path,
      spec: loaded.spec,
      compilerVersion: COMPILER_VERSION,
      promptVersion: PROMPT_VERSION,
    });

    const lock = await this.dependencies.store.acquireLock(created.id);
    try {
      const worktree = await createManagedWorktree({
        sourcePath: source.sourceRoot,
        baseRef: source.baseSha,
        config: this.dependencies.config,
      });
      await this.dependencies.store.append(created.id, {
        type: "worktree_created",
        worktreePath: worktree.path,
        dirtySource: source.dirtySource,
      });
      await this.dependencies.store.append(created.id, { type: "run_started" });
      return await this.executeTasks(created.id, loaded.spec, worktree.path, signal);
    } catch (error) {
      return await this.failRun(created.id, error);
    } finally {
      await lock.release();
    }
  }

  async resumeRun(
    runId: string,
    signal = new AbortController().signal,
  ): Promise<RunProjection> {
    const existing = await this.dependencies.store.load(runId);
    if (existing.state === "completed") return existing;
    if (!existing.worktreePath) throw new Error(`Run ${runId} has no managed worktree to resume`);
    const worktreeStats = await stat(existing.worktreePath).catch(() => undefined);
    if (!worktreeStats?.isDirectory()) {
      throw new Error(`Managed worktree is missing for run ${runId}: ${existing.worktreePath}`);
    }
    await this.dependencies.backend.version();
    const spec = await this.dependencies.store.readSpec(runId);
    const lock = await this.dependencies.store.acquireLock(runId);
    try {
      await this.dependencies.store.append(runId, { type: "run_started" });
      return await this.executeTasks(runId, spec, existing.worktreePath, signal);
    } catch (error) {
      return await this.failRun(runId, error);
    } finally {
      await lock.release();
    }
  }

  private async executeTasks(
    runId: string,
    spec: TaskSpec,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<RunProjection> {
    for (const task of spec.tasks) {
      const current = await this.dependencies.store.load(runId);
      if (current.tasks.find((candidate) => candidate.id === task.id)?.state === "completed") {
        continue;
      }
      const succeeded = await this.executeTask(runId, current, spec, task, worktreePath, signal);
      if (!succeeded) return this.dependencies.store.load(runId);
    }
    return this.dependencies.store.append(runId, { type: "run_completed" });
  }

  private async executeTask(
    runId: string,
    run: RunProjection,
    spec: TaskSpec,
    task: TaskSpecTask,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const attempt = (run.tasks.find((candidate) => candidate.id === task.id)?.attempts ?? 0) + 1;
    const compiled = await compileTask({ runId, baseSha: run.baseSha, spec, task });
    const taskDirectory = `tasks/${task.id}`;
    const promptPath = `${taskDirectory}/attempt-${attempt}.prompt.md`;
    const logPath = `${taskDirectory}/attempt-${attempt}.log`;
    const diffPath = `${taskDirectory}/attempt-${attempt}.diff`;
    const fingerprintPath = `${taskDirectory}/attempt-${attempt}-fingerprint.json`;
    await this.dependencies.store.writeArtifact(runId, promptPath, compiled.prompt);
    const absoluteLogPath = await this.dependencies.store.writeArtifact(runId, logPath, "");
    const before = await captureWorktreeEvidence(worktreePath, run.baseSha);
    await this.dependencies.store.append(runId, {
      type: "task_attempt_started",
      taskId: task.id,
      attempt,
      promptHash: compiled.promptHash,
      promptPath,
      logPath,
    });

    const startedAt = new Date().toISOString();
    let result: WorkerResult;
    try {
      result = await this.dependencies.backend.run({
        task: compiled,
        cwd: worktreePath,
        logPath: absoluteLogPath,
        signal,
      });
    } catch (error) {
      const message = errorMessage(error);
      await this.dependencies.store.append(runId, {
        type: "task_attempt_exited",
        taskId: task.id,
        attempt,
        exitCode: null,
        signal: null,
        evidenceError: message,
      });
      await this.failTask(runId, task.id, attempt, message);
      return false;
    }

    try {
      const after = await captureWorktreeEvidence(worktreePath, run.baseSha);
      await this.dependencies.store.writeArtifact(runId, diffPath, after.trackedDiff);
      await this.dependencies.store.writeArtifact(
        runId,
        fingerprintPath,
        `${JSON.stringify(
          {
            formatVersion: 1,
            promptHash: compiled.promptHash,
            promptPath,
            codexVersion: result.executableVersion,
            args: result.args,
            model: "unknown",
            baseSha: run.baseSha,
            preWorktreeHash: before.worktreeHash,
            postWorktreeHash: after.worktreeHash,
            untracked: after.untracked,
            ignoredFilesExcluded: true,
            startedAt,
            finishedAt: new Date().toISOString(),
            exitCode: result.exitCode,
            signal: result.signal,
            logPath,
            diffPath,
          },
          null,
          2,
        )}\n`,
      );
      await this.dependencies.store.append(runId, {
        type: "task_attempt_exited",
        taskId: task.id,
        attempt,
        exitCode: result.exitCode,
        signal: result.signal,
        fingerprintPath,
        diffPath,
      });
    } catch (error) {
      const message = `Execution evidence failed: ${errorMessage(error)}`;
      await this.dependencies.store.append(runId, {
        type: "task_attempt_exited",
        taskId: task.id,
        attempt,
        exitCode: result.exitCode,
        signal: result.signal,
        evidenceError: message,
      });
      await this.failTask(runId, task.id, attempt, message);
      return false;
    }

    if (result.exitCode !== 0) {
      await this.failTask(
        runId,
        task.id,
        attempt,
        `Worker exited with code ${result.exitCode ?? "null"}${result.signal ? ` (${result.signal})` : ""}`,
      );
      return false;
    }

    await this.dependencies.store.append(runId, {
      type: "task_completed",
      taskId: task.id,
      attempt,
    });
    return true;
  }

  private async failTask(
    runId: string,
    taskId: string,
    attempt: number,
    message: string,
  ): Promise<void> {
    await this.dependencies.store.append(runId, {
      type: "task_failed",
      taskId,
      attempt,
      message,
    });
    await this.dependencies.store.append(runId, { type: "run_failed", message });
  }

  private async failRun(runId: string, error: unknown): Promise<RunProjection> {
    const message = errorMessage(error);
    await this.dependencies.store.append(runId, { type: "run_failed", message });
    return this.dependencies.store.load(runId);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
