# Global screens: New chat, Skills, Tester

Status: specced, not built. Queued behind the security and state-fix work,
which hold `store.ts`, `Sidebar.tsx` and `projectServer.ts`.

## The rule

New chat, Skills and Tester are GLOBAL. They belong to the person, not to a
game. Standing on one of them means you are not in a project, and the rail must
say so: no project row highlighted, no `aria-current` on a project or a chat.

Today the rail does the opposite. It keeps `aria-current="true"` on both the
open project row and the active chat row while you stand on Skills, so a screen
reader is told you are in a conversation you are not in, and the nav rows carry
no active state of their own (their apparent highlight in screenshots is
`:hover`). Sighted users get no answer to "where am I" and blind users get a
wrong one.

## What "not in a project" means, and what it does not

The workspace stays OPEN underneath. The socket stays connected, the game keeps
running, the chat list stays warm, so coming back is instant. What changes is
selection and scope: nothing in the rail is marked current, and a global screen
never reads "the open project" to decide what to show.

Closing the workspace on entry would be the wrong reading. It would tear down
the socket, stop the game, and make every visit to Skills cost a reconnect.

## Tester

A history of every run, across every game, newest first. Each row carries its
project's mark, the way the Chats list already does, because which game a
session belongs to is the first thing you need to know about it.

Header carries a project picker and Play, both on the right. The picker is the
one the composer already uses (`src/projects/ProjectSelector.tsx`), defaulting
to the most recent project. Play runs the tester on whichever is picked. Same
control, same defaulting rule, same place: aiming a global act at a project is
one idea in this app and it should look like one idea.

Opening a report from a row must work without switching project. The report is
read from the row's own project, not from whatever happens to be open.

### Server

`GET /api/tester/history` is per project. This needs an aggregate: sessions
across the recent projects, each tagged with its project path and name, newest
first, capped. Reuse `readSessions` per root rather than inventing a second
reader, and skip a project whose folder has gone rather than failing the whole
read.

Watch the cost. This walks `.hearth/tester/sessions/` for every recent project
on every open of the screen. Cap the projects scanned and the sessions returned,
and say in the code what the cap is protecting.

## New chat

`newChat()` currently sets `composeTarget: get().projectPath`, which pins the
composer to whatever happened to be open. It should default to the MOST RECENT
project instead, and the rail should show nothing selected while the blank
surface is up.

The picker already lets you aim somewhere else, so this is a default, not a
constraint.

## Leaving a global screen

Entering a project (clicking a project row, opening a chat, sending from the
blank composer) clears `screen` and restores selection. That already happens;
what does not is the reverse, and the reverse is the bug: `screen` and
`projectView` both survive `closeWorkspace`, so you can be left on a Tester
screen for a project that is no longer open, complete with a live Play button.
The state-fix agent is closing that now. This spec depends on it landing first.

## Files

- `src/store.ts` — `newChat` default target; a `screen`-aware notion of
  "current"; the `closeWorkspace` reset (already in flight).
- `src/components/shell/Sidebar.tsx` — `NavRow` gains an active state; project
  and chat rows drop `aria-current` while a global screen is up.
- `src/components/tester/TesterHistory.tsx` — global list, project marks, the
  header picker.
- `src/projects/ProjectSelector.tsx` — reused as-is if it will take a caller's
  value and onChange rather than only the composer's.
- `server/projectServer.ts` + `server/tester/` — the aggregate route.

## Test

The rail shows no project or chat as current while any global screen is up, for
all three screens. New chat aims at the most recent project rather than the open
one. The tester list carries rows from more than one project. Opening a report
belonging to a project other than the open one reads the right note.
