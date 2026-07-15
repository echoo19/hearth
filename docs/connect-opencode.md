# Connect OpenCode (and local models via Ollama)

[OpenCode](https://opencode.ai) is an open-source, terminal-based coding
agent that speaks stdio MCP and can run against local models — so it's the
path to driving Hearth entirely on your own machine, no cloud account, no API
key, with a model served by [Ollama](https://ollama.com). Everything stays
local: the engine already runs no model and holds no key, and with Ollama the
*agent's* model is local too.

## Launching from the editor

The editor's **Agent** panel detects `opencode` on your `PATH` (and, for the
provider step below, whatever models a local `ollama` has pulled). Pick
**OpenCode** from the launcher dropdown and click **Start agent**:

1. Prepare writes the `hearth` server into `<project>/opencode.json` under
   the top-level `mcp` key, as `{"type": "local", "command": [...],
   "enabled": true}` — the same shape shown in step 1 below — without
   touching any other keys already in that file.
2. If it detects local Ollama models **and** you don't already have a
   `provider.ollama` block configured, it also writes one for you (step 2
   below), populated with whichever models `ollama list` reported. If you
   already have an `ollama` provider, or none are pulled, it leaves the
   provider section alone.
3. It backfills the project's `.claude/skills/` if missing, then spawns
   `opencode` in the embedded terminal, working directory set to your
   project. The `hearth` CLI is already on that terminal's `PATH`.

Unlike Codex/Hermes, OpenCode's config is per-project (`opencode.json` at the
project root), so nothing here bleeds across projects.

> **Honesty note.** This prepare path — the `opencode.json` write and the
> Ollama provider block — is covered by unit tests asserting the exact
> config shape, but it has not been live-tested end-to-end against a real
> installed OpenCode + Ollama on the machine this shipped from. If something
> looks off, the manual steps below produce the identical config by hand so
> you can compare.

## 1. Register the Hearth MCP server

OpenCode reads MCP servers from `opencode.json` (project root) or
`~/.config/opencode/opencode.json` (global), under the top-level `mcp` key.
Local stdio servers use `type: "local"` and a single **command array**
(command + args together). Note the env key is `environment`, not `env`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hearth": {
      "type": "local",
      "command": ["node", "/abs/path/to/hearth-mcp.mjs", "--project", "/abs/path/to/my-game", "--mode", "safe-edit"],
      "enabled": true
    }
  }
}
```

Grab the standalone `hearth-mcp.mjs` (Node 20+) from the
[latest release](https://github.com/echoo19/hearth/releases/latest), or use
`packages/mcp-server/dist/main.js` from a source checkout. The `--mode` value
is the permission grant (`read-only` / `safe-edit` /
`safe-edit,code-edit,asset-edit` / `all`) — see
[mcp.md](./mcp.md#choosing-modes-per-session).

## 2. Run a local model with Ollama

```bash
ollama pull qwen2.5-coder        # a tool-calling coding model (example)
ollama serve                     # daemon on http://localhost:11434
```

Ollama exposes an OpenAI-compatible endpoint at `http://localhost:11434/v1`.
Register it as an OpenCode provider using the `@ai-sdk/openai-compatible`
adapter:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen2.5-coder": { "name": "Qwen2.5 Coder" }
      }
    }
  }
}
```

Merge this `provider` block with the `mcp` block from step 1 into the same
`opencode.json`. Then select the Ollama model inside OpenCode. (This is
exactly what the panel's prepare step does for you when it finds pulled
models and no existing provider — see above.)

### Local-model gotchas

- **Use the `/v1` path.** `http://localhost:11434/v1`, not Ollama's native
  API path. On Windows prefer `http://127.0.0.1:11434/v1` to dodge
  IPv6/localhost resolution issues.
- **Pick a tool-calling model.** MCP is function calling — the model must
  support tools, or it can't invoke Hearth's commands at all. Coder-tuned and
  Hermes models are good picks (see [connect-hermes.md](./connect-hermes.md));
  many small general models are not.
- **Raise the context window.** Ollama defaults to ~4K tokens, too small for
  agentic tool-calling over a real project. Bump it to 16K+ via a Modelfile
  `num_ctx` or the request `options`, or the agent will forget the task
  mid-loop.
- **No API key needed**, but if a client insists on a non-empty key, pass any
  dummy string.

> **Honesty note.** Local-model quality varies a lot by model and hardware.
> A small local model will follow the snapshot → inspect → edit → validate →
> playtest → diff loop far less reliably than a frontier model. The safety
> rails don't change — permission modes, the command journal, and
> snapshot/diff/revert all work identically regardless of which model is
> driving — so a weak local run is *recoverable*, just slower and more
> hand-held. Treat local models as a private, offline option, not a drop-in
> equal to a hosted frontier agent.

## First thing in a session

Point OpenCode at the project and have it call **`get_agent_instructions`**
first — it returns the `AGENTS.md` house rules and active permission modes.
The working loop and game-craft recipes are in the project skills under
`.claude/skills/`.

## See also

- [connect-hermes.md](./connect-hermes.md) — using a Hermes model locally
- [connect-any-agent.md](./connect-any-agent.md) — any other MCP client
- [mcp.md](./mcp.md) — the full tool list, envelope, and permission modes
