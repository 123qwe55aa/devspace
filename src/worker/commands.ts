import type { ServerConfig } from "../config.js";
import { CodexCliWorker } from "./backend.js";
import type { RunProjection } from "./events.js";
import { WorkerOrchestrator } from "./orchestrator.js";
import { createRunStore } from "./run-store.js";

export type WorkerCliCommand =
  | { kind: "run-new" }
  | { kind: "run-resume"; runId: string }
  | { kind: "status-latest" }
  | { kind: "status"; runId: string }
  | { kind: "runs" };

export function parseWorkerCommand(
  command: "run" | "status" | "runs",
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
  return args[0] ? { kind: "status", runId: args[0] } : { kind: "status-latest" };
}

export function formatRunStatus(run: RunProjection): string {
  return [
    `${run.id} — ${run.state}`,
    `source: ${run.sourceProject}`,
    `base: ${run.baseSha}`,
    `worktree: ${run.worktreePath ?? "not created"}`,
    `dirty source: ${run.dirtySource ? "yes" : "no"}`,
    ...(run.error ? [`error: ${run.error}`] : []),
    "tasks:",
    ...run.tasks.map(
      (task) => `  ${task.id} — ${task.state} — attempts: ${task.attempts} — ${task.title}`,
    ),
  ].join("\n");
}

export function formatRunList(runs: RunProjection[]): string {
  if (runs.length === 0) return "No worker runs found.";
  return runs
    .map((run) => `${run.id} — ${run.state} — ${run.createdAt} — ${run.sourceProject}`)
    .join("\n");
}

export async function executeWorkerCommand(input: {
  command: WorkerCliCommand;
  cwd: string;
  config: ServerConfig;
  runsRoot: string;
  output?: { write(chunk: string): unknown };
}): Promise<void> {
  const output = input.output ?? process.stdout;
  const store = createRunStore(input.runsRoot);
  const orchestrator = new WorkerOrchestrator({
    config: input.config,
    store,
    backend: new CodexCliWorker(),
    onWarning: (warning) => output.write(`warning: ${warning}\n`),
  });

  switch (input.command.kind) {
    case "run-new": {
      const run = await orchestrator.startNewRun(input.cwd);
      output.write(`${formatRunStatus(run)}\n`);
      return;
    }
    case "run-resume": {
      const run = await orchestrator.resumeRun(input.command.runId);
      output.write(`${formatRunStatus(run)}\n`);
      return;
    }
    case "status": {
      output.write(`${formatRunStatus(await store.load(input.command.runId))}\n`);
      return;
    }
    case "status-latest": {
      const run = await store.latest();
      output.write(`${run ? formatRunStatus(run) : "No worker runs found."}\n`);
      return;
    }
    case "runs":
      output.write(`${formatRunList(await store.list())}\n`);
  }
}
