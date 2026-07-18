# Agent Panel

The Agent panel is a real embedded project terminal with a live timeline of
Hearth commands. It does not run a model, hold an API key, or wrap an agent's
protocol. Open a project and the panel starts your platform shell at that
project's root. Type the same command you would in any terminal:

```bash
claude
codex
opencode
hermes
```

Your shell owns command resolution, login, updates, and agent-specific
configuration. This is especially important on Windows, where PowerShell
correctly resolves npm-installed `.cmd` launchers. Hearth does not detect,
install, configure, or launch named agents itself.

The terminal's `PATH` includes a small shim for the bundled `hearth` CLI, so
both you and any shell-native agent can run `hearth` without a global install.
GUI-launched desktop apps also merge the user's login-shell PATH, covering
common locations such as `~/.local/bin`, Homebrew, nvm, mise, and asdf.

New Hearth projects already contain `AGENTS.md`, `CLAUDE.md`, and the
project-local Hearth skills. An agent can therefore use the CLI immediately.
MCP is optional; the per-agent connect guides explain how to register
`hearth-mcp` when you want typed MCP tools as well.

## Beginner guide

The compact guide above the terminal explains the project root, agent command,
and `hearth` PATH setup. Dismissing it is remembered for that project in the
editor's local storage. If browser storage is unavailable, dismissal lasts for
the current mount and the guide safely returns later.

## Session lifetime

There is one PTY per editor connection, so two windows on the same project have
independent shells. Output is buffered outside the React panel, so closing and
reopening the Agent tab preserves the live process and roughly 200K JavaScript
characters of scrollback. Stop kills it explicitly; Restart opens a fresh
shell. Switching projects, losing the WebSocket, or closing the app ends the
session. Terminal history is not persisted to disk.

The terminal is a genuine `@lydell/node-pty` session. xterm only forwards raw
keystrokes, resize events, and output; Hearth does not parse or inject into the
stream.

## Activity and review

Activity below the terminal comes from Hearth's on-disk command journal, not
terminal text. It shows structured CLI/MCP/editor operations and provides the
same review loop as the toolbar:

- **Checkpoint** saves a baseline.
- **Review changes** opens the Changes panel.
- **Restore checkpoint** reverts to the baseline after confirmation.

External changes refresh the open editor through the shared WebSocket. The
conflict model remains last-writer-wins per file; checkpoint, diff, undo, and
the journal are the recovery tools.

## MCP setup

The panel intentionally does not rewrite `.mcp.json`, `opencode.json`,
`~/.codex/config.toml`, or `~/.hermes/config.yaml`. Follow the relevant guide:

- [Claude Code](./connect-claude-code.md)
- [Codex](./connect-codex.md)
- [OpenCode and Ollama](./connect-opencode.md)
- [Hermes](./connect-hermes.md)
- [Any MCP client or CLI agent](./connect-any-agent.md)
