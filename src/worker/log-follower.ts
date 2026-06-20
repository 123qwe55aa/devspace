import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { RunStore } from "./run-store.js";

interface LogCursor {
  offset: number;
  identity?: string;
  decoder: StringDecoder;
  announced: boolean;
}

export interface FollowRunLogsInput {
  store: RunStore;
  runId: string;
  output: { write(chunk: string): unknown };
  signal?: AbortSignal;
  pollIntervalMs?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export async function followRunLogs(input: FollowRunLogsInput): Promise<void> {
  const interval = input.pollIntervalMs ?? 250;
  const wait = input.wait ?? abortableDelay;
  const cursors = new Map<string, LogCursor>();

  while (!input.signal?.aborted) {
    const observation = await input.store.observe(input.runId);
    for (const log of observation.logs) {
      const key = `${log.taskId}:${log.attempt}`;
      let cursor = cursors.get(key);
      if (!cursor) {
        cursor = newCursor();
        cursors.set(key, cursor);
      }

      const metadata = await stat(log.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!metadata) continue;

      const identity = `${metadata.dev}:${metadata.ino}`;
      if (
        cursor.identity !== undefined &&
        (cursor.identity !== identity || metadata.size < cursor.offset)
      ) {
        input.output.write(cursor.decoder.end());
        cursor = newCursor(cursor.announced);
        cursors.set(key, cursor);
      }
      cursor.identity = identity;

      if (!cursor.announced) {
        input.output.write(`==> ${log.taskId} attempt ${log.attempt} <==\n`);
        cursor.announced = true;
      }

      await emitAppendedBytes(log.path, metadata.size, cursor, input.output);
    }

    if (observation.run.state === "completed" || observation.run.state === "failed") {
      for (const cursor of cursors.values()) input.output.write(cursor.decoder.end());
      return;
    }
    await wait(interval, input.signal);
  }
}

function newCursor(announced = false): LogCursor {
  return {
    offset: 0,
    decoder: new StringDecoder("utf8"),
    announced,
  };
}

async function emitAppendedBytes(
  path: string,
  size: number,
  cursor: LogCursor,
  output: { write(chunk: string): unknown },
): Promise<void> {
  if (size <= cursor.offset) return;
  const handle = await open(path, "r");
  try {
    while (cursor.offset < size) {
      const chunk = Buffer.alloc(Math.min(size - cursor.offset, 64 * 1024));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor.offset);
      if (bytesRead === 0) break;
      cursor.offset += bytesRead;
      output.write(cursor.decoder.write(chunk.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
