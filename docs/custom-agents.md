# Bring your own agent

Hearth ships drivers for two harnesses and knows a handful of CLIs by name.
That is a shortlist, not the world. If you have your own agent, your own
harness, or a model behind an API nobody here has heard of, you can register it
and it answers in the conversation like anything else: streaming into the same
transcript, saved into the same `.hearth/chats/*.jsonl`, replayed the same way,
and usable by the playtester.

The protocol is newline-delimited JSON on stdin and stdout. Three events are
required. A wrapper around whatever you already use is about thirty lines, and
there is a complete one at the bottom of this page.

## Register one

Settings, then **Agents**, then **Add an agent**. Three fields:

| Field | What it is |
| --- | --- |
| Name | What you call it. Shown beside the command, never instead of it. |
| Command | The program to run. Found on your login shell's `PATH`, or given as a full path. |
| Arguments | One field per argument. Hearth never splits a command line for you, because a wrong split runs a different command than the one on screen. |

Then confirm the command. An agent cannot answer a turn until you have read the
exact command line and accepted it, and editing that line asks again. This is
one file on your machine and one confirmation per command string, not a policy
engine.

Registered agents live in `~/.hearth/agents.json`, per machine. They are
deliberately **never** written into a project. A folder that carried a command
line would run it on whoever opened the folder next, which is remote code
execution dressed up as a config file. The same reasoning keeps API keys and
permission modes out of the places they would travel from.

Pick your agent from the model menu beside the composer, under **Your agents**.
The row prints the command, the composer pill carries the name, and the
conversation header says which agent is answering.

## How Hearth runs it

Hearth spawns `command args...` once per conversation and keeps it alive across
turns, so your agent can hold whatever context it likes between messages.

* **Working directory** is the open project folder.
* **PATH** is your login shell's, plus Hearth's shim directory, which is the
  same environment the embedded terminal runs with. A GUI-launched app
  otherwise inherits a minimal system `PATH` and would not find anything
  installed by homebrew, nvm, or pipx.
* **Environment** is everything your login shell already has, plus three
  variables. Hearth adds no credentials of its own.

```
HEARTH_PROJECT_ROOT      absolute path to the open project
HEARTH_PERMISSION_MODE   ask | auto | skip, the mode the user chose
HEARTH_PROTOCOL_VERSION  0
```

* **stdin** carries one JSON object per line, from Hearth to you.
* **stdout** carries one JSON object per line, from you to Hearth.
* **stderr** is yours. Log whatever you like there. It is never read as
  protocol, and it never reaches the transcript.

## The handshake

Your **first line of stdout** must be:

```json
{"type":"ready","protocol":0,"supports":{"approvals":true,"permissionModes":["ask","auto","skip"]}}
```

Print it at startup, before you connect to anything. It means "I speak this
protocol", not "I am ready to think": Hearth waits up to 15 seconds for it and
fails the conversation with a visible error if it does not arrive, which is what
stops a mistyped command from binding a conversation that silently never
answers.

`supports.approvals` is a claim, and what it changes is described under
[Permissions](#permissions) below. `supports.permissionModes` is
informational.

Everything after that first line is an event.

## What Hearth writes to you

### prompt

One per turn. This is the whole of what Hearth asks of you.

```json
{
  "type": "prompt",
  "turnId": "t1",
  "text": "make the player double jump",
  "attachments": [{ "path": "/abs/path/sprite.png", "name": "sprite.png", "mimeType": "image/png" }],
  "model": null,
  "effort": null,
  "permissionMode": "auto"
}
```

`attachments` are absolute paths to files already written into the project. They
are paths and not bytes on purpose: you are sitting in the folder, so opening
the file is cheaper and more useful than a base64 blob down a pipe.

`model` and `effort` are what the user picked in the composer, or `null`. They
are passed as information. Hearth has no idea what models you have, so ignoring
them is correct behaviour.

### approval

The answer to an `approval-request` you raised. Only ever sent if you claimed
`approvals` in the handshake.

```json
{ "type": "approval", "approvalId": "a1", "decision": "allow" }
```

`decision` is `"allow"` or `"deny"`.

### interrupt

The user pressed stop. End the named turn and stay running: the next `prompt`
continues the same conversation.

```json
{ "type": "interrupt", "turnId": "t1" }
```

### shutdown

The conversation is over. Close what you hold and exit. Hearth kills the process
straight after, so do not take your time about it.

```json
{ "type": "shutdown" }
```

## What you write back

Every line after the handshake is one event. **Unknown types are dropped, not
fatal**, so a newer Hearth adding an event will not break you and inventing one
of your own will not break the conversation.

### Required

Three events, and a turn made of nothing but these is a real turn.

| Event | Fields | Meaning |
| --- | --- | --- |
| `message-delta` | `text` | Prose, streamed. Send as many as you like. |
| `turn-complete` | none | This turn is done. Hearth waits for the next message. |
| `error` | `message` | This turn failed. Also ends the turn. |

```json
{"type":"message-delta","text":"Adding a double jump to "}
{"type":"message-delta","text":"the player controller.\n"}
{"type":"turn-complete"}
```

**Every turn must end**, with either `turn-complete` or `error`. A turn that
ends in neither leaves a person watching a spinner. If your process exits mid
turn, Hearth reports that as an error and the next message binds a fresh
process, so a crash is untidy rather than silent.

### Optional

Everything below is opt-in richness. Send what you have, skip what you do not,
and add more later without changing anything on Hearth's side.

| Event | Fields | Renders as |
| --- | --- | --- |
| `message-end` | none | The end of one message, so the next one starts a new paragraph rather than being glued on. |
| `reasoning-delta` | `text` | Thinking, streamed. Muted and collapsed. |
| `tool-begin` | `toolId`, `title`, `kind?`, `detail?` | A tool row. `kind` is `command`, `file-change`, `mcp`, `web-search`, `skill` or `other`. |
| `tool-output-delta` | `toolId`, `chunk` | Output inside that row, streamed. |
| `tool-end` | `toolId`, `status?`, `exitCode?`, `summary?` | Settles the row. `status` is `ok`, `error` or `declined`. |
| `file-change` | `files[]`, `toolId?` | Files touched. Each entry is `{ path, kind, diff? }`, kind `edit`, `create` or `delete`. |
| `plan-update` | `text`, `planId?` | The plan card, replaced whole each time. Checkbox lines read well. |
| `approval-request` | `approvalId`, `title`, `kind?`, `detail?` | An inline Allow / Deny. See below. |
| `subagent-start` | `agentId`, `title`, `role?` | A nested agent's card. |
| `subagent-delta` | `agentId`, `chunk` | Its output. |
| `subagent-end` | `agentId`, `status?`, `summary?` | Closes it. |
| `image` | `toolId`, `path`, `caption?` | An image in the project, rendered rather than named. |
| `notice` | `text` | One quiet line. For things that are not actions and not prose. |

Two events are Hearth's own and are ignored if you send them:
`approval-resolved`, because Hearth emits the answer to an approval so that
every window watching the conversation agrees, and the legacy spellings
`text-delta`, `tool-start` and `done`, which exist only so conversations
recorded by older builds still replay.

Ids (`toolId`, `approvalId`, `agentId`, `planId`) are yours to choose and only
have to be unique within the conversation. They key open rows on Hearth's side,
so they are capped at 200 characters.

## Permissions

Hearth has a permission control with three modes: `ask`, `auto` and `skip`. It
passes the mode to you twice, in `HEARTH_PERMISSION_MODE` and on every prompt
frame. What it does **not** do is pretend to enforce it.

Hearth does not own your agent's tool loop. It cannot stop a call it never sees,
and building something that looked like a gate would be worse than saying
nothing, because the transcript would imply Hearth had stopped something.

So there are two honest behaviours, and which one you get is your handshake's
answer:

**You did not claim approvals.** Every turn carries one `notice` saying your
agent enforces its own permissions, that the mode was passed, and that Hearth
shows what happened without gating it. If you raise an `approval-request`
anyway, it is shown as a notice rather than as an Allow / Deny prompt: a turn
that has already said Hearth cannot stop this must not then offer a button that
claims otherwise.

**You claimed approvals.** Then `approval-request` is a real inline prompt, the
turn is expected to block on it, and Hearth answers with an `approval` frame
carrying your `approvalId`. Honour the mode yourself: `skip` means the user
already said yes for this project and you should not be asking.

```json
{"type":"approval-request","approvalId":"a1","kind":"command","title":"Run npm test?","detail":"npm test"}
```

...and back:

```json
{"type":"approval","approvalId":"a1","decision":"allow"}
```

There is no allowlist, no signature check and no sandbox. Hearth cannot sandbox
an arbitrary binary, and a program you registered has exactly the power the
terminal in the next tab already gives you. What Hearth does instead is show the
command everywhere the agent is named, ask you once before it first runs, and
never claim to have contained it.

## A working agent, in about thirty lines

Save this as `my-agent` somewhere on your `PATH`, make it executable, and
register it with the command `my-agent`. It answers by echoing what you said,
one word at a time, which is enough to prove the whole path: the transcript, the
history file, replay, and the tester.

```js
#!/usr/bin/env node
const say = (event) => process.stdout.write(JSON.stringify(event) + '\n');

// First line, always. "I speak this protocol", not "I am ready to think".
say({ type: 'ready', protocol: 0, supports: { approvals: false, permissionModes: ['ask', 'auto', 'skip'] } });

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim() === '') continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === 'shutdown') process.exit(0);
    if (frame.type === 'prompt') {
      answer(frame).catch((err) => say({ type: 'error', message: String(err) }));
    }
  }
});

async function answer(prompt) {
  // Replace this with a call to whatever you actually use. Anything you stream
  // here goes straight into the conversation.
  for (const word of prompt.text.split(' ')) say({ type: 'message-delta', text: word + ' ' });
  say({ type: 'turn-complete' });
}
```

Once that works, add richness in whatever order is useful to you. A `tool-begin`
and `tool-end` pair around each command you run gives you the tool rows. A
`file-change` after each write gives you the file list. A `plan-update` gives you
the plan card. None of it is required, and none of it changes what Hearth asks
of you.

## What Hearth never sends you

There is no field for what kind of game this is, what engine it uses, what
dimension it is in, what tools you should have, or what shape your answer should
take. The prompt carries words, attachments and the user's model choice, and
that is the entire contract. An agent protocol that described the work would be
Hearth deciding what somebody else's agent is for.

If you want the engine's own facts, they are available the same way they are to
any other agent: the MCP server and the CLI, documented in
[mcp.md](./mcp.md) and [cli.md](./cli.md), and the playtest probe in
[probe-shim.md](./probe-shim.md).

## Troubleshooting

**"did not send a Hearth agent handshake"** Your first line of stdout was not
the `ready` object, or nothing arrived within 15 seconds. Check that you print
it before doing any setup work, and that nothing else writes to stdout first.
Startup banners belong on stderr.

**"speaks Hearth agent protocol N"** Your `protocol` field is not `0`.

**"could not find X on your PATH"** Hearth resolves the command against your
login shell's `PATH`, or treats it as a path if it contains a separator. A
command that works in the terminal here works there.

**"has not been confirmed yet"** The command changed since it was confirmed.
Open Settings, find it under Agents, and confirm the new command line.

**The turn never ends.** Something in your loop threw between the prompt and
`turn-complete`. Wrap the whole answer and emit `error` on the way out; an error
ends the turn, and a message on the transcript beats a spinner.
