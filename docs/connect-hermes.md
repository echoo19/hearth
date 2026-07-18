# Connect Hermes

Two things both go by "Hermes" here, and it's worth separating them:
[Hermes](https://nousresearch.com/) the **model family** (Nous Research's
Hermes 2/3/4 fine-tunes, built on Llama and other bases, known for strong
structured function/tool calling), and a **`hermes` agent CLI** you can run in
the editor's Agent terminal if you have one on `PATH`. Which
path applies to you depends on what you've actually installed.

## From the Agent panel (a `hermes` CLI on PATH)

Open a project, focus the Agent panel, and type `hermes`. The shell starts at
the project root with `hearth` already on PATH. Hearth does not detect Hermes
or rewrite `~/.hermes/config.yaml`; configure MCP manually if you want it.

If there's no `hermes` binary on your machine (which is the common case,
since it's the model that gets distributed far more often than a dedicated
CLI), skip to the model path below instead.

## The model path (no `hermes` CLI, just the weights)

If you don't have a `hermes` CLI and instead want to run a Hermes **model**
as the brain behind some other MCP-capable agent:

1. **Serve the Hermes weights** behind an OpenAI-compatible `/v1` endpoint.
   The easiest local route is Ollama:

   ```bash
   ollama pull hermes3
   ollama serve                 # OpenAI-compatible at http://localhost:11434/v1
   ```

   Other servers work identically: `llama.cpp`'s `llama-server`, vLLM, or
   LM Studio each expose an OpenAI-compatible `/v1` server for the same
   weights. Pick whichever you already run.

2. **Use an MCP-capable agent client** as the driver, with the Hermes model
   selected and the Hearth MCP server registered. The client owns the MCP
   connection and the tool-call loop; the model just needs good tool-calling,
   which is Hermes's strength. The most direct option is OpenCode. Its Ollama
   provider setup and the Hearth `mcp` block are covered step-by-step in
   [connect-opencode.md](./connect-opencode.md); just select a `hermes3`
   model instead of the example coder model. Any other MCP client that lets
   you point at a custom OpenAI-compatible base URL works too. See
   [connect-any-agent.md](./connect-any-agent.md).

That's the whole story for this path: the Hermes model is the *brain*,
OpenCode (or another MCP client) is the *agent*, and Hearth's stdio MCP
server is the *tools*.

## Why Hermes specifically

Hermes fine-tunes are trained hard on structured tool/function calling, so
they tend to invoke MCP tools more reliably than a general small model of
similar size. That matters for Hearth, where the whole workflow is the agent
calling typed commands (`create_entity`, `run_playtest`, `get_diff`) and
branching on the `CommandResult` envelope. If a local model can't call tools
cleanly, it can't drive Hearth at all.

The [local-model gotchas](./connect-opencode.md#local-model-gotchas)
from the OpenCode page apply unchanged: use the `/v1` path, raise the context
window past Ollama's ~4K default, and remember that local-model quality varies
with model size and hardware. Hearth's safety rails (permission modes, the
command journal, snapshot/diff/revert) are identical no matter which model
drives, so a weaker local run is recoverable, just slower and more hand-held
than a frontier agent.

## First thing in a session

Whichever client you drive Hermes from, have it call
**`get_agent_instructions`** first. It returns the `AGENTS.md` house rules
and active permission modes. The working loop and game-craft recipes are in
the project skills under `.claude/skills/`.

## See also

- [connect-opencode.md](./connect-opencode.md): the concrete OpenCode + Ollama setup
- [connect-any-agent.md](./connect-any-agent.md): any other MCP client
- [mcp.md](./mcp.md): the full tool list, envelope, and permission modes
