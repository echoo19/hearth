# The `hearth-probe` MCP server

`hearth-probe-mcp` is the probe for an agent that speaks MCP and is working
*outside* the Hearth app: Claude Code in a terminal, or any other MCP client.
It exposes the same operations the CLI does, over stdio, and writes the
same evidence files: a sweep run from Claude Code and a sweep run from the
`hearth-probe` CLI are byte-for-byte the same record, because both go through
the same evidence store.

## Register it

The server ships with each release as a single-file `hearth-probe-mcp.mjs`
bundle (or build `@hearth/probe-tools` from a source checkout, see
[cli.md](./cli.md#getting-it)), then point your client at it. One server
serves one project root, given at launch:

```bash
claude mcp add hearth-probe -- \
  node /abs/path/to/hearth-probe-mcp.mjs --project ~/Hearth/tiny-roguelike
```

The generic MCP client config is the same shape everywhere:

```json
{
  "mcpServers": {
    "hearth-probe": {
      "command": "node",
      "args": ["/abs/path/to/mcp.js", "--project", "/abs/path/to/game"]
    }
  }
}
```

`--project` is the default directory every tool uses; tools that take a `dir`
resolve it relative to that root. Working on several games at once means
registering several servers with different names.

It drives the game in headless Chromium, so the host needs an installed Chrome
or Edge, `CHROMIUM_PATH`, or a `npx playwright install chromium` browser.

## The tools

| Tool | What it does |
| --- | --- |
| `probe_sweep` | Play the game with seeded bots and report what broke. Writes `.hearth/evidence`. |
| `probe_report` | Re-read the latest sweep's folded summary. Launches nothing, costs nothing. |
| `probe_capabilities` | Report what the game lets the probe see, and whether the shim was detected. |
| `probe_install_shim` | Copy the reference probe shim into the game and return the integration snippet. |
| `probe_screenshot` | Open the game, let it run, return one frame as an image plus its path on disk. |

Every tool answers with the same JSON envelope `hearth-probe --json` prints,
stringified into a text block: one vocabulary, whichever door an agent came
through. `probe_screenshot` additionally returns the PNG inline.

The tool descriptions teach the loop rather than merely naming parameters, so
an agent that has never seen Hearth can read the tool list and know what to do
next.

## The evidence it writes

`probe_sweep` writes under the project:

```
.hearth/evidence/
  journal.jsonl                          append-only event stream
  sweeps/0001/report.json                the folded report
  sweeps/0001/runs/<policy>-<seed>.json  one file per episode
  sweeps/0001/shots/*.png                frames the findings point at
```

Those files are the whole record, and they are the same ones a sweep run from
the CLI leaves behind. An agent sweeping over MCP and a person reading the
folder afterwards see the same run. The layout and what to read first are in
[playtesting.md](./playtesting.md).

## Reading results honestly

Two things the tool descriptions repeat, because they are the two ways an agent
misreads a sweep:

- **The bot is deterministic; the game is not.** The tally is a distribution.
  One clean run proves nothing.
- **Skipped is not passed.** Detectors whose senses the game doesn't declare
  appear under `skipped`. "No findings" never means "nothing was checked". When
  that list is long, `probe_capabilities` says why and `probe_install_shim` is
  the fix ([probe-shim.md](./probe-shim.md)).

Depth beyond the folded lists lives in `report.json` and `runs/*.json`; the
envelope tells you where they are.
