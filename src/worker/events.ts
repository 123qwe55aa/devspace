import * as z from "zod/v4";

export type RunState = "planned" | "running" | "completed" | "failed";
export type TaskState = "pending" | "running" | "completed" | "failed";

const eventDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_created"),
    sourceProject: z.string(),
    baseSha: z.string(),
    specPath: z.string(),
    compilerVersion: z.number().int().positive(),
    promptVersion: z.string(),
    tasks: z.array(z.object({ id: z.string(), title: z.string() }).strict()),
  }).strict(),
  z.object({
    type: z.literal("worktree_created"),
    worktreePath: z.string(),
    dirtySource: z.boolean(),
  }).strict(),
  z.object({ type: z.literal("run_started") }).strict(),
  z.object({
    type: z.literal("task_attempt_started"),
    taskId: z.string(),
    attempt: z.number().int().positive(),
    promptHash: z.string(),
    promptPath: z.string(),
    logPath: z.string(),
  }).strict(),
  z.object({
    type: z.literal("task_attempt_exited"),
    taskId: z.string(),
    attempt: z.number().int().positive(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    fingerprintPath: z.string().optional(),
    diffPath: z.string().optional(),
    evidenceError: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("task_completed"),
    taskId: z.string(),
    attempt: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("task_failed"),
    taskId: z.string(),
    attempt: z.number().int().positive(),
    message: z.string(),
  }).strict(),
  z.object({ type: z.literal("run_completed") }).strict(),
  z.object({ type: z.literal("run_failed"), message: z.string() }).strict(),
]);

export const runEventSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive(),
    runId: z.string(),
    timestamp: z.string(),
  })
  .and(eventDataSchema);

export type RunEventData = z.infer<typeof eventDataSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;

export interface RunTaskProjection {
  id: string;
  title: string;
  state: TaskState;
  attempts: number;
}

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
  tasks: RunTaskProjection[];
}

export function reduceRunEvents(events: RunEvent[]): RunProjection {
  if (events.length === 0 || events[0]?.type !== "run_created") {
    throw new Error("Corrupt event journal: sequence must start with run_created");
  }

  const created = events[0];
  let projection: RunProjection = {
    id: created.runId,
    state: "planned",
    sourceProject: created.sourceProject,
    baseSha: created.baseSha,
    specPath: created.specPath,
    compilerVersion: created.compilerVersion,
    promptVersion: created.promptVersion,
    createdAt: created.timestamp,
    updatedAt: created.timestamp,
    tasks: created.tasks.map((task) => ({ ...task, state: "pending", attempts: 0 })),
  };

  const task = (taskId: string): RunTaskProjection => {
    const found = projection.tasks.find((candidate) => candidate.id === taskId);
    if (!found) throw new Error(`Corrupt event journal: unknown task ${taskId}`);
    return found;
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sequence !== index + 1 || event.runId !== projection.id) {
      throw new Error(`Corrupt event journal at sequence ${event.sequence}`);
    }
    projection.updatedAt = event.timestamp;
    if (index === 0) continue;

    switch (event.type) {
      case "run_created":
        throw new Error("Corrupt event journal: duplicate run_created");
      case "worktree_created":
        projection.worktreePath = event.worktreePath;
        projection.dirtySource = event.dirtySource;
        break;
      case "run_started":
        if (projection.state === "completed") {
          throw new Error("Corrupt event journal: completed run cannot restart");
        }
        projection.state = "running";
        projection.error = undefined;
        break;
      case "task_attempt_started": {
        const current = task(event.taskId);
        if (current.state === "completed" || event.attempt !== current.attempts + 1) {
          throw new Error(`Corrupt event journal: invalid attempt for task ${event.taskId}`);
        }
        current.state = "running";
        current.attempts = event.attempt;
        break;
      }
      case "task_attempt_exited":
        if (event.attempt !== task(event.taskId).attempts) {
          throw new Error(`Corrupt event journal: invalid exit attempt for task ${event.taskId}`);
        }
        break;
      case "task_completed": {
        const current = task(event.taskId);
        if (event.attempt !== current.attempts) {
          throw new Error(`Corrupt event journal: invalid completion for task ${event.taskId}`);
        }
        current.state = "completed";
        break;
      }
      case "task_failed": {
        const current = task(event.taskId);
        if (event.attempt !== current.attempts) {
          throw new Error(`Corrupt event journal: invalid failure for task ${event.taskId}`);
        }
        current.state = "failed";
        projection.error = event.message;
        break;
      }
      case "run_completed":
        if (projection.tasks.some((candidate) => candidate.state !== "completed")) {
          throw new Error("Corrupt event journal: run completed before all tasks");
        }
        projection.state = "completed";
        projection.error = undefined;
        break;
      case "run_failed":
        projection.state = "failed";
        projection.error = event.message;
        break;
    }
  }

  return projection;
}
