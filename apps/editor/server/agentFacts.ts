/**
 * The house facts: what an agent needs to know about the room it is working
 * in, told once, at bind, in the system prompt.
 *
 * A fresh Hearth project is an empty folder — that is the point, the agent
 * builds however it likes — but empty means there is no file anywhere that
 * says "the folder is served live in a game pane", "playtest evidence lands
 * in .hearth/evidence/", or ".hearth/context/ holds things the person wants
 * you to read". Without this block the agent works inside an app whose whole
 * shape it cannot see: it writes a game that needs a dev server and wonders
 * why the pane is blank, or is asked "what did the playtest find?" and greps
 * for a log it has never heard of.
 *
 * Two rules keep this from becoming a leash:
 *
 *  - **Facts, not directions.** The block says where the pane looks and where
 *    evidence lands. It never says what kind of game to make, what library to
 *    use, or what a game ought to contain — the person's message and the
 *    project's own AGENTS.md are the only places direction comes from.
 *  - **Short.** Every token here is one the person's actual request does not
 *    get, on every turn of every conversation. It stays a few sentences per
 *    topic, and anything that has a doc gets pointed at rather than inlined.
 *
 * Composed alongside `personalPrompt` (personalization.ts) into the same
 * system-prompt seam both backends already have — the Agent SDK's preset
 * `append`, codex's `developerInstructions`. The facts come FIRST: they are
 * the room, the person's standing preferences are a voice in it.
 */

/**
 * Where the game pane (and a sweep) looks for a project's web game, in
 * priority order. Zero required conventions is the point: the agent builds
 * however it likes, and Hearth looks in the handful of places a web game
 * plausibly lands. Lives here — a leaf module — so the server can serve from
 * it and the prompt can state it without either importing the other.
 */
export const GAME_ENTRY_CANDIDATES = ['index.html', 'game/index.html', 'dist/index.html', 'public/index.html'];

/**
 * Where the skills mirror lands, as the prompt says it.
 *
 * Written with forward slashes on every platform, because this is prose an
 * agent reads rather than a path the server joins, and `.claude\skills` in a
 * sentence reads as an escape. The value matches `CLAUDE_SKILLS_DIR` in
 * skills.ts, which is the one that actually creates the folder; a literal here
 * keeps this module a leaf, and a test pins the two together.
 */
export const SKILLS_PROMPT_DIR = '.claude/skills/';

/** What the environment can actually offer this conversation. */
export interface AgentFactsOptions {
  /**
   * True when a working `hearth-probe` is on the agent's PATH (see
   * hearthShim.ts). The probe paragraph is only spoken when the command would
   * actually run: telling an agent about a tool it cannot invoke produces a
   * turn that ends in "command not found" and an agent that trusts the rest
   * of this block less.
   */
  probeCli: boolean;
  /**
   * True when at least one enabled skill was mirrored into this project.
   *
   * Skills reach the two backends Hearth drives natively: the Agent SDK
   * discovers them from the folder it works in, and codex is handed the same
   * folder through `skills/extraRoots/set`. Neither of those helps anything
   * else, and "anything else" is most of what people run here — a registered
   * CLI, a shell agent, whatever is next. Those agents can read a file like
   * any other, so the folder is NAMED here and they can go and look. That is
   * the difference between a skill library that belongs to two vendors and one
   * that belongs to the person.
   *
   * Silent when the folder is empty, on the same rule as the probe paragraph
   * below: telling an agent to consult a library that does not exist spends
   * tokens to produce a wasted directory listing.
   */
  skills: boolean;
}

/**
 * The block itself. Deterministic — same options, same string — so a test can
 * pin a sentence and a transcript diff between two conversations means the
 * environment differed, not the phrasing.
 */
export function hearthFactsPrompt(options: AgentFactsOptions): string {
  const entries = GAME_ENTRY_CANDIDATES.join(', ');
  const parts = [
    'You are working inside Hearth, a desktop app where a person and an agent make a game together. ' +
      'The working folder is the project. Beside this conversation the app keeps a game pane that serves ' +
      `the folder over HTTP and reloads as files change; it looks for, in order: ${entries}. ` +
      'Any web game that runs from static files works. There is no required engine, framework, or format, ' +
      'and how the game is built is entirely up to you. If you use a build step, put the output at one of ' +
      'those entries so the pane (and playtests) can find it.',

    'There are two different playtests and they are not interchangeable. The TESTER is the one the person ' +
      'uses: a model opens the game and plays it the way a person would, keeps notes across sessions, and ' +
      'writes each session under .hearth/tester/sessions/<n>/, with note.json holding what it saw and what ' +
      'it proposes, and .hearth/tester/memory.md holding what it remembers about this game. The person ' +
      'starts it from the app and can send you work from its report. Read those files when a session comes ' +
      'up. It reports only what it actually saw, so treat anything it says it could not work out as ' +
      'genuinely unknown rather than as a hint.',

    'The BOT SWEEP is yours, not the person\u2019s: seeded bots driven headlessly at the game, real keys, ' +
      'real pointer, screenshots, console errors, written under .hearth/evidence/. journal.jsonl is ' +
      'appended as it runs; sweeps/<n>/report.json holds the verdicts and findings; sweeps/<n>/shots/ the ' +
      'frames findings point at. It has no surface in the app: it is run from a shell, never by the person ' +
      'pressing something. It finds crashes, not fun.',

    'Which bots can play is decided by what the game tells them. With no cooperation, only random-input ' +
      'bots run: they find crashes, not progress. A game that installs the probe shim (window.__hearthProbe, ' +
      'v1) and declares entities() gets the seek bot, which steers at the entity tagged "objective"; add ' +
      'navGrid() and seek paths to it instead of walking at it, and wander explores the map. Wiring those ' +
      'two hooks early is the difference between a playtest that mashes buttons and one that plays the game.',
  ];
  if (options.probeCli) {
    parts.push(
      'Playtesting is yours to run: `hearth-probe sweep .` drives those bots from your shell and ' +
        'writes that evidence, `hearth-probe screenshot .` captures a frame of the running game, ' +
        '`hearth-probe shim .` installs the reference shim (its header documents every hook), and ' +
        '`hearth-probe --help` lists the rest.',
    );
  }
  if (options.skills) {
    parts.push(
      `Skills the person keeps are mirrored into ${SKILLS_PROMPT_DIR}, one folder each, with a SKILL.md ` +
        'holding a name, a description of when it applies, and the instructions. They are the person’s ' +
        'library rather than this game’s, and they are there for whatever is answering, which is you: ' +
        'read the descriptions, and read a skill in full when the work is the work it describes. The folder ' +
        'is named for the first agent that read it and means nothing about who it is for.',
    );
  }
  parts.push(
    'Hearth can put this project on the Hearth Catalog (catalog.hearthengine.com): free hosting for the ' +
      'folder as it stands, and an address the person can send to anyone. It is the Publish action in the ' +
      'top bar, and it sends the same files the game pane serves. A session that ends with a game that ' +
      'runs is a session where that step is worth mentioning.',
  );
  parts.push(
    '.hearth/context/ holds reference files the person added for you. Read them before making big ' +
      'decisions. The rest of .hearth/ (chats/, evidence/, tester/) is the app’s own record of this ' +
      'project; read it freely, but do not edit it.',
  );
  return parts.join('\n\n');
}

/**
 * The one composition rule, shared by both backends so they can never drift:
 * facts first, then whatever the person set. Null only when there is truly
 * nothing to say — which today cannot happen (the facts always say the pane
 * exists), but the shape keeps the callers' "omit the key entirely" behavior
 * meaningful rather than dead.
 */
export function composeAgentInstructions(facts: string | null, personal: string | null): string | null {
  const parts = [facts, personal].filter((part): part is string => part !== null && part.trim() !== '');
  return parts.length === 0 ? null : parts.join('\n\n');
}
