import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { ExecutionTask } from "./compiler.js";

const execFileAsync = promisify(execFile);

export interface WorkerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  executableVersion: string;
  args: string[];
}

export interface WorkerRunInput {
  task: ExecutionTask;
  cwd: string;
  logPath: string;
  signal: AbortSignal;
}

export interface WorkerBackend {
  version(): Promise<string>;
  run(input: WorkerRunInput): Promise<WorkerResult>;
}

export class CodexCliWorker implements WorkerBackend {
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { executable?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.env = options.env ?? process.env;
    this.executable = options.executable ?? this.env.DEVSPACE_CODEX_BIN ?? "codex";
  }

  async version(): Promise<string> {
    try {
      return (await execFileAsync(this.executable, ["--version"], { env: this.env })).stdout.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex CLI is unavailable at ${this.executable}: ${message}`);
    }
  }

  async run(input: WorkerRunInput): Promise<WorkerResult> {
    await mkdir(dirname(input.logPath), { recursive: true });
    const args = [
      "exec",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "-C",
      input.cwd,
      "-",
    ];
    const executableVersion = await this.version();
    const log = createWriteStream(input.logPath, { flags: "w" });

    return new Promise<WorkerResult>((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd: input.cwd,
        env: this.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let settled = false;
      const abort = () => child.kill("SIGTERM");
      input.signal.addEventListener("abort", abort, { once: true });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.stdin.end(input.task.prompt);

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener("abort", abort);
        log.end(() => reject(error));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener("abort", abort);
        log.end(() => {
          resolve({ exitCode, signal, executableVersion, args: [...args] });
        });
      });
    });
  }
}
