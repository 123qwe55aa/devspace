# Worker Logs Command Design

## Goal

Add a read-only `devspace logs` command for watching the raw Codex output of the active task in a Worker run. The command is intended for background runs: it prints content already written, follows new output, automatically advances to the next task attempt, and exits when the run reaches a terminal state.

## CLI Contract

```text
devspace logs
devspace logs <run-id>
```

- With no run ID, the command follows the latest run in the configured run store.
- With a run ID, the command follows that run.
- The command accepts at most one run ID. It does not add separate tail or non-follow modes in this version.
- `Ctrl+C` stops only the log viewer. It does not signal, cancel, or otherwise modify the Worker run.
- If no runs exist, the command prints `No worker runs found.` and exits successfully.
- Invalid or unknown run IDs use the CLI's existing error path.

The help output adds:

```text
devspace logs [run-id]    Follow raw Codex logs; defaults to the latest run
```

## Data Source and Boundaries

The event journal remains the sole lifecycle-state authority. `logs` reads task-attempt metadata from valid `task_attempt_started` events and reads the referenced `.log` evidence artifacts. It never derives lifecycle state from log contents and never writes to the run directory.

The run store exposes a narrow read API that returns the validated event history needed by the follower. Artifact paths are resolved beneath the selected run directory and rejected if they escape it. A corrupt event journal fails visibly through the existing validation path rather than being silently skipped.

No Worker process attachment is introduced. This keeps the viewer independent of foreground, background, resumed, and already-completed executions.

## Follow Behavior

The follower polls the run journal and active log artifact at a short fixed interval (250 ms).

1. Resolve the selected run and read its validated events.
2. Discover task attempts in journal order from `task_attempt_started` events.
3. For each newly discovered attempt, print a concise separator containing task ID and attempt number, then emit that log from byte zero.
4. Continue emitting only bytes appended since the previous poll.
5. When a later task attempt appears, finish any unread bytes from the previous log and switch automatically.
6. When the run becomes `completed` or `failed`, perform one final read of all discovered logs, then exit.

The viewer tracks byte offsets, not decoded character counts. It retains an incomplete UTF-8 sequence between reads so multibyte output is not corrupted at chunk boundaries. Log truncation or replacement resets the offset to zero and emits the current file content again, which matches the evidence file's observable state.

If a `task_attempt_started` event exists but its log file is not yet visible, the follower waits. This handles the small race between journal observation and filesystem visibility without reporting a false failure.

## Output

The command writes raw combined Codex stdout/stderr to standard output. Before each attempt it prints:

```text
==> T2 attempt 1 <==
```

No timestamps, colors, or line prefixes are injected into Worker output. Errors go through the normal CLI error reporting path.

## Cancellation and Errors

- The CLI passes its existing abort signal to the follower.
- Abort ends polling promptly and successfully; it never touches the run lock or Worker process.
- Read failures other than a temporarily missing attempt log are surfaced.
- A terminal run with no task attempts exits successfully without fabricated log output.
- Polling timers do not keep running after completion, failure, cancellation, or an exception.

## Testing

Tests cover:

- parsing `logs` with no run ID and with one run ID;
- rejecting extra arguments;
- following an existing active attempt from the beginning;
- emitting appended bytes without duplication;
- switching to a later task attempt;
- waiting for a not-yet-visible log file;
- exiting after a final flush when the run completes or fails;
- stopping the viewer without cancelling the Worker;
- preventing artifact paths from escaping the selected run directory;
- CLI help and end-to-end command wiring.

Tests use injectable polling and output dependencies so they run deterministically without real-time sleeps or a Codex subprocess.

## Explicit Non-Goals

- Filtering by task or attempt.
- Historical aggregation formatting.
- Searching, pagination, timestamps, or JSON output.
- Streaming logs over MCP or a network transport.
- Attaching directly to the Codex subprocess.
- Changing Worker execution, event semantics, locks, retries, or verification.
