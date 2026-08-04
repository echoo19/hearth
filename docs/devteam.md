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
interrupting an engineer mid-edit. A note that is queued rather than answered
gets a receipt in the transcript ("Noted. The lead reads this at the next
handoff."), so an absorbed message is never silent. Steering is text-only:
attachment controls return when the run is done and the composer becomes an
ordinary lead chat.

## Scheduling and controls

Hearth runs two engineers at once. There is no setting for this yet. Task
dependencies are honored. Tasks whose declared path scopes overlap never run
together, and a task with no scope runs alone, so a plan that declares no scopes
runs one task at a time. This scheduling reduces write collisions but is not a
filesystem lock.

The run's controls live on the board's rail, beside the steps. **Stop**
interrupts running engineers, withdraws their unanswered approvals and
questions, and leaves the run interrupted and resumable; it does not end the
run. **Pause** appears during a build and stops new dispatch while
already-running engineer turns finish. A parked run offers **Resume**, and a
message to the lead does the same thing: it picks the run back up from the
saved phase and carries what you typed into that turn. During a lead turn, the
composer's own Stop halts the run the same way. To build something different,
start a new dev team conversation. A crash, quit, lead-driver failure, or
exhausted plan-repair budget also produces an interrupted run that can be
resumed after reopening.

If a task fails, the lead reviews the milestone knowing which tasks failed and
may add remediation work by rewriting `plan.json`. A milestone runs again at most
once this way; after that the failure is carried into the closing handoff rather
than described as finished.

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
lead-written handshakes that Hearth validates before advancing; when `plan.json`
does not match the schema, Hearth tells the lead which field is wrong. Each
engineer transcript uses the same record shape as an ordinary chat. State writes
are serialized, flushed, and replaced atomically. A `state.json` that cannot be
read is moved aside as `state.json.corrupt` and the conversation starts a fresh
run, rather than becoming unusable.

Opening or reloading a Dev Team conversation reads these files and replays the
most recent activity in each engineer lane; the full record stays on disk. Work
that was running in a prior process is marked interrupted, because Hearth cannot
claim an external driver survived a process exit; Resume uses stored Claude
session or Codex thread continuation ids where available. A specification
waiting for your approval is not treated as interrupted work — reopening puts
you back in front of the same spec and its Approve button.

## Current limits

- Scheduling uses declared path scopes, not a cross-agent filesystem lock.
- Every engineer uses the lead's provider and model; per-engineer provider
  mixing and skill filtering are not available.
- Run history is uncapped, so a very long-lived conversation can make
  `state.json` grow. Engineer replay is capped at the most recent activity per
  lane, but the files themselves are never truncated.
- There is no way to cancel or retry one engineer. A task whose provider hangs
  holds its slot until the whole run is stopped.
- Deleting a dev team conversation first stops its lead and engineers, then
  removes the chat entry, lead transcript, and that conversation's
  `.hearth/devteam/<chatId>/` artifacts. If a provider does not close within the
  shutdown deadline, deletion fails, and the conversation is retained with its
  run left interrupted so it can be reopened and resumed.
- The private playtester and terminal-door agents are not automatic team
  members.
