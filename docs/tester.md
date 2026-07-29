# The private tester

Your tester plays your game the way a person would. It looks at the screen,
decides what to press, presses it, looks again, and at the end it writes down
what it made of the game and whether your last change helped.

It is a model, not a bot. It runs on whichever agent you connected
([agents.md](./agents.md)), so it is Claude or ChatGPT looking at screenshots of
your game and saying what it thinks. It remembers every previous session in a
file you can read and edit. And it plays only when you press **Play**, because
every turn is a model call on your own quota.

Two of the three doors reach it. Hearth calls the model itself here, through
the same backend the conversation uses, so it needs either an Anthropic key or
a ChatGPT sign-in through the open-source Codex CLI. A CLI you run yourself in
the Terminal tab is not something Hearth can drive, and a project with neither
backend configured answers Play by saying it could not reach your agent.

The other thing that plays your game is the bot sweep, which is a different
tool for a different question ([playtesting.md](./playtesting.md)). Bots produce
evidence and no opinions. The tester produces an opinion and shows you the
pictures behind it.

There are two ways in. The pane beside your game has a **Tester** tab with the
Play button on it, which is where you watch a session happen. **Tester** in the
sidebar is a screen of its own listing every session across every game you have
made, newest first, each row opening its own report. That screen is global on
purpose: a playtest belongs to a game, but the history of playtests belongs to
you.

## What a session is

The tester opens your game in a headless browser, the same one the sweeps
drive, and takes turns.

A turn is a picture and a decision. Hearth screenshots the game, sends the
picture with a short prompt saying which inputs this game has and how many
turns are left, and the tester answers with a sentence about what it sees and
one instruction line: hold these inputs, click here, move the pointer there,
put me somewhere, or **DONE**. The instruction is played into the game, the
game advances, and the next picture is taken. You watch all of it: the frame on
the left, its thinking beside it.

Twenty-four turns is the budget. The session ends when the tester says it has
seen enough, when the budget runs out, when you press Stop, or when something
breaks. Every one of those endings writes a note. A session that happened and
left no record would be worse than one that recorded a failure, so a crash
half way through still produces a note saying so.

Then it is asked four more questions, always in this order:

1. What did you see? One line per thing, each naming the picture it happened on.
   Plus one line for anything it could not work out.
2. What changed since last time, and did it help? Four answers: what it
   understood you changed, better or worse or no difference, why, and whether
   anything got worse.
3. Is anything worth changing? Bugs it watched go wrong, and preferences, each
   naming the pictures behind it.
4. Rewrite what you know about this game, for yourself to read next time.

One session per project at a time. Asking for a second while one is playing is
refused rather than queued.

## The honesty rules

This is the part worth reading twice. A tester that overclaims is worse than no
tester, because you act on what it tells you: you keep a change it said helped,
and you stop looking at a level it said was fine. Praise you cannot check does
the damage of a wrong instruction while sounding like encouragement. So the
value of this whole feature rests on what the tester is not allowed to say, and
most of those rules are enforced by Hearth rather than requested of the model.

### It says whether it got there by playing

A game can offer places the tester may be dropped into, if it says so through
the probe shim by implementing both `listStates` and `enterState`
([probe-shim.md](./probe-shim.md)). The tester is told the list once, as an
offer and never an instruction, along with the sentence that what it finds by
playing is worth more.

If it takes the offer, everything from the next picture onward is recorded as
**placed** rather than played, for the rest of the session. The report marks
those observations, and any proposal resting on one of them carries a sentence
on its own row saying the game put it there, so this says nothing about whether
a player can reach it.

The reason is that a tester dropped into year three of a management sim can
honestly report that year three plays well, while the budget rules make year
two impossible to survive, and the report would still read as glowing. Where
something happened decides what the finding is worth, so the report says where,
every time.

### Every claim points at a picture

Observations are anchored, and the report renders them that way:
`Picture 7: the audit total went negative`. A claim about a picture the session
never took is dropped rather than shown with an apology, because a claim about
picture forty of a ten-picture session is about a picture nobody took.

The plan of action is stricter. A proposal has to name at least one picture
from this session or it does not appear at all. Without that rule the tester
can hand back advice anyone could have written without playing your game, and a
list of plausible-sounding changes is the most flattering thing a playtester
can produce.

Whatever the rule drops is then counted in the report, in a sentence saying how
many proposals fell out and why. That count is the difference between a session
that found nothing and a session whose findings could not be anchored. Without
it, both come back as "It found nothing here worth changing", which is a
sentence about your game rather than about a parse, and reads as a clean bill
of health.

### The verdict is only about the change since last session

Before it plays, the tester is given what the project recorded happening since
it last played: the commands that ran, with the properties they changed, and
what you asked for in your own words in the conversation. Deliberately not a
git diff. A diff shows which lines moved, and the journal and the conversation
carry what you were trying to do.

The verdict is one of better, worse or no real difference, and it is about that
and nothing else. A first session cannot give one at all: it is forced to
"first session" by Hearth rather than asked for, so no first note can claim a
verdict on a change it never saw the before-state of.

Two orderings protect it. The tester writes down everything it saw this session
**before** it is shown the verdict it gave last time, so it cannot anchor on its
own praise. And it is told plainly that disagreeing with itself is more useful
than being consistent. When it does reverse, the history says so on the row.

A verdict line that is not one of the three is recorded as no verdict rather
than the nearest one. "Not better, if anything worse" is a refusal to say
better, and it is not a claim that things got worse either, so the report says
no verdict was given and shows everything else on the session as normal.
Rounding it would put "That helped" on screen over a sentence that said the
opposite, in the one line this whole feature exists to deliver.

### Whether anything got worse is a required answer

Silence is not "nothing". If the tester answers the other questions and skips
that one, it is asked again, on its own. If it still says nothing, the report
says it did not say, rather than filling in reassurance. An optional field here
would be answered by silence every time, and that is how a tester becomes a
flattery machine.

### It says when it could not work something out

Anything it could not figure out goes down as an open question and is carried
into the next session, instead of being smoothed into a confident sentence. It
is also told, in as many words, that it is not a good player and must never
claim to be, and that it must never say it finished something it did not watch
finish.

### It is told when its input never arrived

If it asks for something the game never received, the next prompt names it and
ends with the line that this is not the game failing to respond. That sentence
carries real weight. A tester that reads "R to restart" off the screen, asks
for R, and has the press dropped in silence will conclude the game is stuck,
and it will write that down about your game rather than about the press.

### Bugs and preferences never merge

It watched the crash happen. It did not watch the jump being unfair. The report
and the plan keep the two apart under headings that say which is which, and the
heading over the second one says out loud that it cannot judge fun.

### Sessions are never rewritten

A note is written once and is never edited afterwards. The verdict history is
the product: a tester that could revise what it used to think could never be
caught contradicting itself, and being caught is the point. If a note on disk
is in a shape this version of Hearth cannot read, the session still appears in
the history saying exactly that, rather than vanishing or being shown with the
half that parsed.

## How it presses keys

Two vocabularies reach the game, and the difference matters.

The first is what Hearth could work out about your game from the outside: the
actions, axes and pointer the adapter declares. For a web game with no shim
that is a small default set of names mapped to keys; a game that ships a shim
declares its own list ([probe-shim.md](./probe-shim.md)). An action it names is
held down for the next moment of play and released at the top of the following
turn, so "right" and then "left" means it changed its mind rather than that it
is holding both.

The second is the raw keyboard, and it exists because games state their own
controls on screen far more often than they declare them to a shim. A game
printing "press R to restart" while declaring only left, right and jump is
normal, not broken. So the tester is invited to read the controls off the
picture, and a name it asks for becomes a keypress **when that name is already
the name of a key**:

- One printable character is that character's key, upper-cased, because `r` and
  `R` are one physical key.
- A longer name has to match a key that has a written name: `Space`, `Enter`,
  `Escape`, `Tab`, `ArrowLeft`, `PageUp`, `F3`. Spelling variants of the same
  name are allowed, so `esc`, `uparrow` and `page up` all arrive.

Everything else is a word for an idea and gets nothing. There is deliberately
no entry turning `jump` into Space, and that omission is a design decision
rather than an oversight. There is no key for jump. It is Space in a platform
game, Z in another, A on a pad, and nothing at all in a game with no jumping.
The moment Hearth held a table like that, it would be telling you what kind of
game you are allowed to have written, and Hearth makes no assumption about
genre, dimension, engine or input. So it declines, and it says out loud that it
declined: the tester is told the name never reached the game and why, in the
next prompt and in the transcript.

The keyboard offer is only made when the adapter actually has a keyboard to
drive. A tester told it may press what the screen tells it to, whose presses
then go nowhere, is worse off than one that was never told.

## Memory

The tester keeps one file:

```
.hearth/tester/memory.md
```

Plain markdown, rewritten whole at the end of every session. It holds what the
tester believes about your game: the controls, what the goal seems to be, what
it has already tried, what it got wrong last time. It is asked to write it so
that the person who owns the game could read it and correct anything it got
wrong.

Do that. Open the file and fix it. A memory you cannot inspect is one you
cannot trust, and a tester you cannot correct is one you stop listening to. If
it has decided your resource meter is a health bar, one line in that file saves
you three sessions of findings built on top of the mistake.

Memory is the only thing about the tester that changes. Sessions are
append-only; this file is where being wrong gets fixed.

## The report and the plan of action

The report shows every section every time, including the ones whose answer is
nothing: how the session ended, the verdict on your last change, whether
anything got worse, where it played, what it saw, what it still could not work
out, and what it thinks is worth changing. A heading that only appears when
there is bad news teaches a reader to skim past it.

The last section is the only part where you answer. Nothing arrives ticked.
Bugs sit above preferences, each row carries the pictures behind it and its own
caveat if the game put the tester there, and the button does nothing until you
tick something.

**Start work** opens a new conversation carrying the ticked items and nothing
else. Not the rest of the plan, not the rest of the session: a proposal in an
agent's context is a proposal it may act on, so carrying the whole plan would
make the ticking decorative. The message names the folder the pictures are in
so the agent can open them, and its last line tells the agent that the rest of
the session is not there and to ask rather than fill in the gaps.

It is an ordinary conversation from that point on, which is the useful part.
You can argue with it, narrow it, or tell it the tester was wrong.

## Where everything lands

Under the project, like everything else Hearth writes. Copy the folder and the
tester comes with it.

```
.hearth/tester/
  memory.md                        what it knows, hand-editable
  sessions/0001/note.json          the session, written once
  sessions/0001/transcript.md      everything it said, in order
  sessions/0001/frames/0001.png    the pictures its claims point at
```

Session ids are zero-padded sequence numbers, so a path stays stable and can be
pasted into a conversation. The frames are written as it plays, which is why
they exist before the note that cites them. The note is written last, with a
flag that refuses to overwrite an existing one.

## What it does not do, and cannot know

Be generous with this list when you read a report.

- **It is not a good player.** It is told to say so, and a level it could not
  get past is not proof the level is impossible. It is one attempt by a model
  looking at still pictures.
- **It sees pictures and nothing else.** Nothing about your game reaches it as
  sound. If the only warning before an attack is a noise, the tester will never
  know the warning was there.
- **It does not read your code.** It is told to answer from the pictures and
  not to read the source. That is an instruction it follows rather than a wall
  Hearth builds around it, so treat it as the ground rule for the session and
  not as a sandbox.
- **It cannot judge timing or feel.** One picture per turn, seconds apart. It
  has no view of frame rate, input latency, animation, or whether a jump arc
  feels right.
- **It cannot tell you whether the game is fun.** The prompt says so and the
  report repeats it. Everything under preferences is a preference.
- **One session is one path.** It is not coverage, it does not repeat itself
  with different seeds, and it never claims to have seen the whole game. Bot
  sweeps are the tool for volume ([playtesting.md](./playtesting.md)).
- **It runs none of the sweep detectors.** No crash watcher, no black-screen
  check, no stuck detector. If a crash does not show up in a picture it looks
  at, the session will not mention it.
- **It cannot really type.** There is no line for entering a string. One turn
  holds one set of keys, so getting a name into a text box would cost a turn
  per letter out of a budget of twenty-four.
- **It cannot prove cause.** It says whether this session felt better than the
  last one. Both sessions were played by a model that plays differently every
  time, so a single reversal is a data point rather than a result.
- **It does not know what you intended** beyond what the project recorded: the
  commands that ran and the messages you sent. Something you changed by hand in
  an editor, outside Hearth, is invisible to it.
- **It cannot be scheduled.** There is no timer and no CI mode, and nothing
  starts a session when a file changes. It plays when you press Play.

## Permissions, and who is watching

The tester binds its own agent with the default permission setting, whatever
this project's permission mode says
([agents.md](./agents.md#permission-modes)). That is deliberate in both
directions. Under **Ask first** every step would raise an approval into an
empty room and the session would wedge, and under **Skip all checks** an
unattended agent would be running with no sandbox at all.

If anything does raise an approval during a session, it is denied on sight,
because the thing that would answer it is a person watching a conversation and
nobody is.
