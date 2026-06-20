import { randomBytes } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  reduceRunEvents,
  runEventSchema,
  type RunEvent,
  type RunEventData,
  type RunProjection,
} from "./events.js";
import { parseTaskSpec, type TaskSpec } from "./spec.js";

export interface CreateRunInput {
  sourceProject: string;
  baseSha: string;
  specPath: string;
  spec: TaskSpec;
  compilerVersion: number;
  promptVersion: string;
}

export interface RunLock {
  release(): Promise<void>;
}

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
  readonly root: string;
  createRun(input: CreateRunInput): Promise<RunProjection>;
  append(runId: string, event: RunEventData): Promise<RunProjection>;
  load(runId: string): Promise<RunProjection>;
  rebuildProjection(runId: string): Promise<RunProjection>;
  list(): Promise<RunProjection[]>;
  latest(): Promise<RunProjection | undefined>;
  observe(runId: string): Promise<RunObservation>;
  observeLatest(): Promise<RunObservation | undefined>;
  nextAttempt(runId: string, taskId: string): Promise<number>;
  acquireLock(runId: string): Promise<RunLock>;
  writeArtifact(
    runId: string,
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<string>;
  readSpec(runId: string): Promise<TaskSpec>;
}

export function createRunStore(root: string): RunStore {
  return new FileRunStore(root);
}

class FileRunStore implements RunStore {
  constructor(readonly root: string) {}

  async createRun(input: CreateRunInput): Promise<RunProjection> {
    await mkdir(this.root, { recursive: true });
    const runId = createRunId();
    const directory = this.runDirectory(runId);
    await mkdir(directory);
    await writeFile(join(directory, "spec.json"), `${JSON.stringify(input.spec, null, 2)}\n`);

    const event: RunEvent = {
      version: 1,
      sequence: 1,
      runId,
      timestamp: new Date().toISOString(),
      type: "run_created",
      sourceProject: input.sourceProject,
      baseSha: input.baseSha,
      specPath: input.specPath,
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
      tasks: input.spec.tasks.map(({ id, title }) => ({ id, title })),
    };
    await appendFile(join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`);
    const projection = reduceRunEvents([event]);
    await this.writeProjection(runId, projection);
    return projection;
  }

  async append(runId: string, data: RunEventData): Promise<RunProjection> {
    await this.repairTruncatedTail(runId);
    const events = await this.readEvents(runId);
    if (events.length === 0) throw new Error(`Unknown run: ${runId}`);
    const event = runEventSchema.parse({
      ...data,
      version: 1,
      sequence: events.length + 1,
      runId,
      timestamp: new Date().toISOString(),
    });
    await appendFile(this.eventsPath(runId), `${JSON.stringify(event)}\n`);
    const projection = reduceRunEvents([...events, event]);
    await this.writeProjection(runId, projection);
    return projection;
  }

  async load(runId: string): Promise<RunProjection> {
    return this.rebuildProjection(runId);
  }

  async rebuildProjection(runId: string): Promise<RunProjection> {
    const projection = reduceRunEvents(await this.readEvents(runId));
    await this.writeProjection(runId, projection);
    return projection;
  }

  async list(): Promise<RunProjection[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
        .map((entry) => this.load(entry.name).catch(() => undefined)),
    );
    return runs
      .filter((run): run is RunProjection => run !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async latest(): Promise<RunProjection | undefined> {
    return (await this.list())[0];
  }

  async observe(runId: string): Promise<RunObservation> {
    const events = await this.readEvents(runId);
    const logEvents = events.filter((event) => event.type === "task_attempt_started");
    return {
      run: reduceRunEvents(events),
      logs: await Promise.all(
        logEvents.map(async (event) => ({
          taskId: event.taskId,
          attempt: event.attempt,
          path: await this.resolveReadableArtifactPath(runId, event.logPath),
        })),
      ),
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

  async nextAttempt(runId: string, taskId: string): Promise<number> {
    const run = await this.load(runId);
    const task = run.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Unknown task ${taskId} in run ${runId}`);
    return task.attempts + 1;
  }

  async acquireLock(runId: string): Promise<RunLock> {
    const path = join(this.runDirectory(runId), "run.lock");
    const ownerPath = join(path, "owner.json");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(path);
        const token = randomBytes(16).toString("hex");
        try {
          await writeFile(
            ownerPath,
            `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
          );
        } catch (error) {
          await rm(path, { recursive: true, force: true });
          throw error;
        }
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            const owner = await readLockOwner(ownerPath);
            if (owner?.token === token) {
              await rm(path, { recursive: true, force: true });
            }
          },
        };
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const owner = await readLockOwner(ownerPath);
        if (owner === undefined || isProcessAlive(owner.pid)) {
          throw new Error(
            owner
              ? `Run ${runId} is already running in process ${owner.pid}`
              : `Run ${runId} is already running`,
          );
        }
        await rm(path, { recursive: true, force: true });
      }
    }
    throw new Error(`Run ${runId} is already running`);
  }

  async writeArtifact(
    runId: string,
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<string> {
    const path = this.resolveArtifactPath(runId, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  async readSpec(runId: string): Promise<TaskSpec> {
    const input = JSON.parse(await readFile(join(this.runDirectory(runId), "spec.json"), "utf8"));
    return parseTaskSpec(input);
  }

  private runDirectory(runId: string): string {
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
    return join(this.root, runId);
  }

  private resolveArtifactPath(runId: string, relativePath: string): string {
    const runDirectory = this.runDirectory(runId);
    const path = resolve(runDirectory, relativePath);
    const relationship = relative(runDirectory, path);
    if (
      isAbsolute(relativePath) ||
      relationship === ".." ||
      relationship.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      throw new Error(`Artifact path must stay inside the run directory: ${relativePath}`);
    }
    return path;
  }

  private async resolveReadableArtifactPath(runId: string, relativePath: string): Promise<string> {
    const path = this.resolveArtifactPath(runId, relativePath);
    const metadata = await lstat(path).catch((error) => {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (metadata && !metadata.isFile()) {
      throw new Error(`Log artifact must be a regular file: ${relativePath}`);
    }
    return path;
  }

  private eventsPath(runId: string): string {
    return join(this.runDirectory(runId), "events.jsonl");
  }

  private async readEvents(runId: string): Promise<RunEvent[]> {
    const content = await readFile(this.eventsPath(runId), "utf8");
    const lines = content.split("\n");
    const endsWithNewline = content.endsWith("\n");
    const events: RunEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const isIncompleteFinalLine =
          !endsWithNewline &&
          index === lines.length - 1 &&
          isTruncatedJsonError(error, line);
        if (isIncompleteFinalLine) break;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Corrupt event at line ${index + 1}: ${message}`);
      }
      try {
        events.push(runEventSchema.parse(parsed));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Corrupt event at line ${index + 1}: ${message}`);
      }
    }
    return events;
  }

  private async repairTruncatedTail(runId: string): Promise<void> {
    const path = this.eventsPath(runId);
    const content = await readFile(path, "utf8");
    if (!content || content.endsWith("\n")) return;

    const lastNewline = content.lastIndexOf("\n");
    const tail = content.slice(lastNewline + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(tail);
    } catch (error) {
      if (isTruncatedJsonError(error, tail)) {
        await truncate(path, lastNewline + 1);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Corrupt event at final line: ${message}`);
    }
    try {
      runEventSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Corrupt event at final line: ${message}`);
    }
    await appendFile(path, "\n");
  }

  private async writeProjection(runId: string, projection: RunProjection): Promise<void> {
    const target = join(this.runDirectory(runId), "run.json");
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(projection, null, 2)}\n`);
    await rename(temporary, target);
  }
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `run_${timestamp}_${randomBytes(4).toString("hex")}`;
}

async function readLockOwner(
  path: string,
): Promise<{ pid: number; token: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    return typeof parsed.pid === "number" && typeof parsed.token === "string"
      ? { pid: parsed.pid, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(
    typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}

function isTruncatedJsonError(error: unknown, input: string): boolean {
  if (!(error instanceof SyntaxError)) return false;
  if (/unexpected end|unterminated/i.test(error.message)) return true;
  const position = /position (\d+)/i.exec(error.message)?.[1];
  return position !== undefined && Number(position) >= input.length;
}
