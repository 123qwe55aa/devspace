import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as z from "zod/v4";

const text = (max: number) => z.string().trim().min(1).max(max);
const relativeFile = text(1_000);

const moduleSchema = z
  .object({
    name: text(200),
    responsibility: text(2_000),
    files: z.array(relativeFile).max(100),
  })
  .strict();

const taskSchema = z
  .object({
    id: text(64).regex(
      /^[A-Za-z0-9._-]+$/,
      "Task IDs may contain letters, numbers, dot, underscore, and dash",
    ),
    title: text(200),
    instruction: text(20_000),
    files: z.array(relativeFile).max(100),
    constraints: z.array(text(2_000)).max(100),
    acceptanceCriteria: z.array(text(2_000)).max(100),
  })
  .strict();

export const taskSpecSchema = z
  .object({
    version: z.literal(1),
    project: text(200),
    goal: text(20_000),
    architecturePlan: z
      .object({
        summary: text(20_000),
        modules: z.array(moduleSchema).max(100),
      })
      .strict(),
    tasks: z.array(taskSchema).min(1).max(100),
  })
  .strict();

export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type TaskSpecTask = TaskSpec["tasks"][number];

export interface LoadedTaskSpec {
  spec: TaskSpec;
  path: string;
  warnings: string[];
}

export function taskSpecPath(projectRoot: string): string {
  return join(projectRoot, ".devspace", "spec", "current.json");
}

export function parseTaskSpec(input: unknown): TaskSpec {
  const spec = taskSpecSchema.parse(input);
  const ids = new Set<string>();

  for (const task of spec.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id ${task.id}`);
    }
    ids.add(task.id);
  }

  const declaredPaths = [
    ...spec.architecturePlan.modules.flatMap((module) => module.files),
    ...spec.tasks.flatMap((task) => task.files),
  ];
  for (const path of declaredPaths) {
    assertSafeRelativePath(path);
  }

  return spec;
}

export async function loadTaskSpec(projectRoot: string): Promise<LoadedTaskSpec> {
  const path = taskSpecPath(projectRoot);
  const spec = parseTaskSpec(JSON.parse(await readFile(path, "utf8")) as unknown);
  const warnings: string[] = [];

  for (const file of new Set(spec.tasks.flatMap((task) => task.files))) {
    if (!(await stat(join(projectRoot, file)).catch(() => undefined))) {
      warnings.push(`${file} does not exist in the base checkout`);
    }
  }

  return { spec, path, warnings };
}

function assertSafeRelativePath(path: string): void {
  const portablePath = path.replaceAll("\\", "/");
  const segments = portablePath.split("/");
  const windowsAbsolute = /^[A-Za-z]:\//.test(portablePath) || portablePath.startsWith("//");

  if (
    isAbsolute(path) ||
    windowsAbsolute ||
    path.includes("\0") ||
    segments.includes("..")
  ) {
    throw new Error(`Declared file path must be project-relative: ${path}`);
  }
}
