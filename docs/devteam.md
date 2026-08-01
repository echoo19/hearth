# Dev Team mode

Dev Team mode turns one conversation into a lead plus a small team of coding
agents. Start one with **New dev team** in the sidebar, or select **Dev team**
on the Home composer before sending the first description.

Hearth orchestrates the team itself. The selected Claude or Codex backend is
used for both the lead and every engineer, so the lifecycle and board are the
same with either provider. A terminal conversation cannot be a Dev Team run,
and the mode will not start until a supported agent is connected.

## From idea to working game

1. **Interview.** The lead reads your request and asks only for missing detail.
   Structured questions use the normal question controls; prose replies work
   too. The lead writes `spec.md` when it has enough information.
2. **Spec.** Read the specification card. Choose **Approve & build**, or type a
   revision and let the lead rewrite it. Every approved version is retained.
3. **Build.** The lead writes a validated plan of milestones, tailored roles,
   and tasks. Hearth runs ready engineer tasks, shows each engineer's live
   transcript, and keeps approvals and questions in the lane that raised them.
   The lead reviews each completed milestone before the next one starts.
4. **Done.** The lead writes a wrap-up. The completed board remains as a
   collapsible run record, and the composer returns to an ordinary conversation
   with the same lead. Sending another request starts a new run and preserves
   the previous one in history.

Messages sent while planning or building are durable steering notes. Hearth
folds them into the lead's next planning, review, or wrap turn instead of
interrupting an engineer mid-edit.

## Scheduling and controls

Hearth starts up to two engineers at once by default, and the server always
caps configured concurrency at four. Task dependencies are honored.
Tasks whose declared path scopes overlap never run together, and a task with no
scope runs alone. This scheduling reduces write collisions but is not a
filesystem lock.

**Pause** stops new dispatch while already-running engineer turns finish.
**Resume** continues from the saved phase. **Stop** interrupts running
engineers, withdraws their unanswered approvals and questions, and leaves the
run in an interrupted, resumable state. A crash, quit, lead-driver failure, or
exhausted plan-repair budget also produces an interrupted run that can be
resumed after reopening.

Engineers inherit the conversation's provider, model, permission mode, and
available tools. A plan may set low, medium, or high effort per task. In Ask
mode, every command or file operation that needs permission can pause its own
engineer lane; Automatic mode is usually smoother for a team run.

## Files and reload

The lead's visible conversation remains at
`.hearth/chats/<chatId>.jsonl`. Dev Team artifacts live beside it:

```text
.hearth/devteam/<chatId>/
  state.json
  spec.md
  spec.v1.md, spec.v2.md, ...
  plan.json
  engineers/<engineerId>.jsonl
```

`state.json` records the phase, plan, task status, continuation ids, steering,
approvals, summaries, and completed-run history. `spec.md` and `plan.json` are
lead-written handshakes that Hearth validates before advancing. Each engineer
transcript uses the same record shape as an ordinary chat. State writes are
serialized and replaced atomically; malformed or future-version state appears
as an interrupted, unreadable run instead of crashing the app.

Opening or reloading a Dev Team conversation reads these files and replays the
engineer transcripts. Active work from a prior process is marked interrupted,
because Hearth cannot claim an external driver survived a process exit; Resume
uses stored Claude session or Codex thread continuation ids where available.

## Current limits

- Scheduling uses declared path scopes, not a cross-agent filesystem lock.
- Every engineer uses the lead's provider and model; per-engineer provider
  mixing and skill filtering are not available.
- Run history and engineer transcript replay are currently uncapped, so a very
  long-lived conversation can make `state.json` and reopen replay grow.
- Deleting a conversation removes its chat entry and lead transcript, but its
  `.hearth/devteam/<chatId>/` artifacts are currently retained as orphaned
  local files. They can be removed manually once the conversation is gone.
- The private playtester and terminal-door agents are not automatic team
  members.
