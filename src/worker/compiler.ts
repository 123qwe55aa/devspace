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

  if (/{{[A-Z_]+}}/.test(prompt)) {
    throw new Error("Worker prompt contains unresolved placeholders");
  }

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
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- None specified";
}
