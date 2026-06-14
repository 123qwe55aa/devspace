# DevSpace

Expose a secure local coding workspace through a Streamable HTTP MCP server.

DevSpace connects MCP-capable hosts such as ChatGPT or Claude to a local
development machine. The host calls MCP tools directly; work is not delegated to
a separate local agent loop.

## Tool Naming Modes

Default tool naming is controlled by `DEVSPACE_TOOL_NAMING`.

Legacy naming, the current default:

- `open_workspace`
- `read_file`
- `write_file`
- `edit_file`
- `grep_files`
- `find_files`
- `list_directory`
- `run_shell`

Short naming, enabled with `DEVSPACE_TOOL_NAMING=short`:

- `open_workspace`
- `read`
- `write`
- `edit`
- `grep`
- `glob`
- `ls`
- `bash`

Set `DEVSPACE_TOOL_MODE=minimal` to disable the dedicated search/list tools. In
that mode, the server instructs clients to use the shell tool with command-line
programs such as `grep`, `rg`, `find`, `ls`, and `tree` for search and directory
inspection.

Server-level workflow guidance is exposed through MCP initialize instructions,
not a dedicated info tool.

## Persistent Result Payloads

Tool result payloads are persisted in a global SQLite database under
`~/.local/share/devspace/devspace.sqlite`, or under `DEVSPACE_STATE_DIR` when
that variable is set. This lets UI cards such as edit/write diff viewers reload
historical payloads after the MCP server process restarts.

Workspace IDs remain live-session identifiers; after a restart, open the
workspace again for new file, edit, search, or shell tool calls.

## Workspace Flow

Call `open_workspace` before using the coding tools:

```json
{
  "path": "~/personal/my-project"
}
```

Absolute paths such as `/home/waishnav/personal/my-project` are also supported.

The result includes a `workspaceId`. Use that `workspaceId` for subsequent
calls:

```json
{
  "workspaceId": "ws_...",
  "path": "README.md"
}
```

The server automatically loads `AGENTS.md` files for the workspace root and for
directories reached by later file, list, search, edit, write, or shell calls.
Tool responses include whether each discovered `AGENTS.md` was newly loaded or
already loaded in that workspace.

## Run Locally

```bash
npm install --include=dev
npm run typecheck
npm run build

DEVSPACE_TOKEN="change-me" \
DEVSPACE_ALLOWED_ROOTS="/home/waishnav/personal,/home/waishnav/work" \
DEVSPACE_ALLOWED_HOSTS="localhost,127.0.0.1,agent.gitcms.blog" \
DEVSPACE_PUBLIC_BASE_URL="https://agent.gitcms.blog" \
DEVSPACE_TOOL_MODE="full" \
DEVSPACE_TOOL_NAMING="legacy" \
npm run dev
```

## Release Builds

Use release builds for long-running MCP server processes:

```bash
npm run release:build

DEVSPACE_TOKEN="change-me" \
DEVSPACE_ALLOWED_ROOTS="/home/waishnav/personal,/home/waishnav/work" \
DEVSPACE_ALLOWED_HOSTS="localhost,127.0.0.1,agent.gitcms.blog" \
DEVSPACE_PUBLIC_BASE_URL="https://agent.gitcms.blog" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_TOOL_NAMING="short" \
npm run release:start
```

`release:build` runs the normal build, copies the built `dist/` tree into a new
`releases/<release-id>/dist` directory, and updates `releases/current` to point
at that immutable copy. A server already running from `npm run release:start`
continues to use its existing release while normal development builds can keep
rewriting `dist/`.

The regular `npm run build` and `npm run start` commands are still useful for
local development and smoke testing. For production-style long-running servers,
prefer `release:build` followed by restarting `release:start`.

The MCP endpoint is:

```text
http://127.0.0.1:7676/mcp
```

Send `Authorization: Bearer <DEVSPACE_TOKEN>` when `DEVSPACE_TOKEN` is set.

## Cloudflare Tunnel

Point a Cloudflare Tunnel hostname at the local server:

```text
http://127.0.0.1:7676
```

Then configure the remote MCP client with:

```text
https://your-tunnel-hostname.example.com/mcp
```

## Security Notes

This server exposes local filesystem and shell capabilities. Treat it like
remote code execution on this machine.

- Always use `DEVSPACE_TOKEN` outside purely local smoke tests.
- Keep `DEVSPACE_ALLOWED_ROOTS` narrow.
- If you expose the server through a tunnel, add the tunnel hostname to `DEVSPACE_ALLOWED_HOSTS`.
- Put Cloudflare Access or equivalent in front of the tunnel before exposing it.
- The shell tool can escape filesystem allowlists by design; shell access relies
  on authentication and client trust, not path containment.
