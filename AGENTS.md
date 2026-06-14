# pi-on-mcp

This project is an experiment to expose a local development harness over MCP so
ChatGPT, Claude, or another MCP-capable host can operate directly on this
machine's development environment.

The goal is not to delegate work to a separate local coding agent. The MCP host
should call tools that read files, edit files, search code, and run shell
commands directly against approved local project roots.

Pi's SDK is being evaluated as the backend for mature local coding primitives
such as read, edit, write, grep, find, ls, and bash. The MCP server should wrap
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls over autonomous local agent loops.
- Keep the first version small enough to validate with real ChatGPT/Claude MCP
  clients before adding UI or workflow features.
