# Wave L — Agent Capability Parity Cross-Check (Task 16, Step 1)

> Spec Phase 2b commitment: **agents CAN do everything** — every game-affecting
> action reachable in the editor UI must be reachable via CLI/MCP commands.
> Editor-chrome-only concerns (dock layout, tab arrangement, view toggles,
> code-editor conveniences) are exempt. This document walks the 16 Phase-0
> audits panel-by-panel, maps each capability to its CLI command + MCP tool (or
> marks GAP / EXEMPT), and judges the reverse direction (commands with no editor
> surface — fine, agents-first, listed for completeness).

**Surfaces cross-checked.** Core command registry
(`packages/core/src/commands/registry.ts`, **71 commands**); MCP tool catalog
(`packages/mcp-server/src/tools.ts`, **68 command-backed tools** + 2 specials:
`screenshot`, `get_agent_instructions`); CLI grammar
(`packages/cli/src/program.ts`, 89 subcommands + `init`/`commands`). CLI and MCP
both dispatch through `HearthSession.execute`; there is **no generic
command-passthrough** in either surface, so a registry command with no named
subcommand/tool is genuinely unreachable by an agent.

**Legend.** ✓ = reachable. GAP = editor can, agent cannot. EXEMPT = editor-chrome
/ runtime-view only (one-word reason). MORE = agent is *more* capable than the
editor (editor lacks the affordance; the audit filed it as friction).

---

## Forward direction — every editor capability → CLI + MCP

### Launcher + TemplatePicker
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Create project (blank) | `init <name>` | — | ✓ CLI (MCP operates in-project — agents-first asymmetry, by design) |
| Create project from template | `init <name> --template <t>` | — | ✓ CLI |
| List available templates | `init --list-templates` | — | ✓ CLI |
| Open a project | — | — | EXEMPT (session) |
| Recent list, browse buttons | — | — | EXEMPT (chrome) |

### Toolbar + SceneMenu + ViewMenu
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Create scene | `create scene` | `create_scene` | ✓ |
| Duplicate scene (± copy playtests) | `duplicate scene` | `duplicate_scene` | ✓ |
| Rename scene | `rename scene` | `rename_scene` | ✓ |
| Set as initial scene | (setInitialScene) | `set_initial_scene` | ✓ |
| Delete scene | `delete scene` | `delete_scene` | ✓ |
| Undo / Redo | (undo/redo) | `undo` / `redo` | ✓ |
| Checkpoint | (snapshotProject) | `snapshot_project` | ✓ |
| Review changes | (diffProject) | `get_diff` | ✓ |
| Export | `export web/desktop` | `export_web` / `export_desktop` | ✓ |
| Switch active scene (picker) | — | — | EXEMPT (view state) |
| Play / Stop / Pause / Step / Debug / Restart badge | — | — | EXEMPT (runtime; agent analog = `run_playtest` / `run_scene` / `screenshot`) |
| Close project, View menu, Reset layout, shortcut sheet | — | — | EXEMPT (chrome) |

### Hierarchy
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Create entity | `create entity` | `create_entity` | ✓ |
| Rename entity | `rename entity` | `rename_entity` | ✓ |
| Duplicate entity (subtree) | `duplicate entity` | `duplicate_entity` | ✓ |
| Delete entity | `delete entity` | `delete_entity` | ✓ |
| Reparent (Inspector Parent dropdown; drag is L-014) | `move entity` | `move_entity` | ✓ |
| Save as prefab | `prefab create` | `create_prefab` | ✓ |
| **Enable / disable entity** (Inspector header toggle) | — | — | **GAP → `setEntityEnabled`** (core cmd exists, unsurfaced both sides) |
| **Set entity tags** (Inspector Tags field, post-create) | create-only (`create entity --tags`) | — | **GAP → `setEntityTags`** (core cmd exists; CLI only at creation, no MCP tool) |
| Collapse, select, multi-select, tree search | — | — | EXEMPT (chrome) |

### SceneView
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Drag-move / resize / rotate (Transform) | `set` / `set-many` | `set_component_property` / `set_properties` | ✓ |
| Polygon / LineRenderer vertex edit (points array) | `set` / `set-many` | `set_component_property` / `set_properties` | ✓ |
| Tilemap paint (single cell) | `paint tiles` | `paint_tiles` | ✓ |
| Tilemap fill rectangle | `paint tilemap` / fill | `fill_tilemap_rect` | ✓ |
| Tilemap resize | (resizeTilemap) | `resize_tilemap` | ✓ |
| Autotile rules | (setTileAutotile) | `set_tile_autotile` | ✓ |
| Camera pan/zoom, gizmos, grid, particle preview | — | — | EXEMPT (view) |

### Inspector (core + specialized)
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Add component | `create component` | `add_component` | ✓ |
| Remove component | `remove component` | `remove_component` | ✓ |
| Set any field (scalar/vec2/color/list) | `set` | `set_component_property` | ✓ |
| Batch multi-field set (corner-resize, etc.) | `set-many` | `set_properties` | ✓ |
| PostEffects add/remove/reorder (component array) | `set` / `set-many` | `set_component_property` / `set_properties` | ✓ |
| Tilemap grid rows + tileAssets | `set` + (setTileAutotile) | `set_component_property` + `set_tile_autotile` | ✓ |
| Script scriptPath / params (typed key/value) | `set` / `set-many` | `set_component_property` / `set_properties` | ✓ (also `attach script` / `attach_script`) |
| Entity Name | `rename entity` | `rename_entity` | ✓ |
| Entity Parent | `move entity` | `move_entity` | ✓ |
| **Entity Enabled toggle** | — | — | **GAP → `setEntityEnabled`** (same as Hierarchy row) |
| **Entity Tags** | create-only | — | **GAP → `setEntityTags`** (same as Hierarchy row) |
| Instantiate prefab | `prefab place` | `instantiate_prefab` | ✓ |
| Update prefab | `prefab update` | `update_prefab` | ✓ |
| Sync instances | (syncPrefabInstances) | `sync_prefab_instances` | ✓ |
| Revert override (per-field / all) | `prefab revert` | `revert_prefab_override` | ✓ |
| Prefab detach (auto on structural edit) | via `create/remove component` | via `add/remove_component` | ✓ (auto-detach on both sides; no explicit affordance either — parity holds) |
| Set input mapping (entity-scoped) | (setInputMapping) | `set_input_mapping` | ✓ |

### Assets + SliceDialog + bulk import
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Import single / bulk | `import asset` | `import_asset` / `import_assets` | ✓ |
| Create sprite | `create asset sprite` | `create_sprite_asset` | ✓ |
| Create tile | `create asset tile` | `create_tile_asset` | ✓ |
| Create sound | `create asset sound` | `create_sound` | ✓ MORE (editor has no "+ Sound" — L-049) |
| Create animation | `create asset animation` | `create_animation_asset` | ✓ |
| Create state-machine asset | `create asset state-machine` | `create_state_machine_asset` | ✓ MORE (editor has no "+ State machine" — L-084) |
| Slice spritesheet | `create asset slice` | `slice_spritesheet` | ✓ |
| Create animation from sheet | `create asset anim-from-sheet` | `create_animation_from_sheet` | ✓ |
| Delete asset (referenced-by protected) | `remove asset` | `remove_asset` | ✓ MORE (editor has no delete UI — L-044) |
| **Rename asset** | — | — | *Not a current parity gap* (editor cannot either — L-044 open); **forward-dependency**: if T9/U3 lands rename UI, needs a new `renameAsset` command → defer-to-M |
| **Duplicate asset** | — | — | *Not a current parity gap* (editor cannot either — L-044); **forward-dependency**: if T9/U3 lands duplicate UI, needs new `duplicateAsset` → defer-to-M |
| Copy id, assign, play audio | — | — | EXEMPT (chrome) |

### Code panel
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Create script | `create script` | `create_script` | ✓ |
| Edit script | (editScript) | `edit_script` | ✓ |
| Format (+ format-on-save setting) | `format` + `update_settings` codeStyle | `format_script` + `update_settings` | ✓ |
| Lint / check | (checkScript) | `check_script` | ✓ |
| Search across scripts | (searchScripts) | `search_scripts` | ✓ |
| Replace across scripts | (replaceInScripts) | `replace_in_scripts` | ✓ |
| ctx API reference (hover docs analog) | `inspect api` | `inspect_api` | ✓ |
| Tabs, per-buffer undo, dirty dots, in-file search | — | — | EXEMPT (code-editor convenience) |

### Console + Changes/History
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Validate project | `validate` | `validate_project` | ✓ |
| Checkpoint | (snapshotProject) | `snapshot_project` | ✓ |
| Diff / review body | (diffProject) | `get_diff` | ✓ |
| Restore checkpoint | (revertProject) | `revert_project` | ✓ |
| Undo / redo + history list | (undo/redo/listHistory) | `undo` / `redo` / `list_history` | ✓ |
| Log view, level filter, copy | — | — | EXEMPT (chrome) |

### Agent panel
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Timeline (command journal) | (listJournal) | `list_journal` | ✓ |
| Checkpoint / Restore | snapshot / revert | `snapshot_project` / `revert_project` | ✓ |
| Launch agent, terminal, permission mode, `.mcp.json` prepare | — | — | EXEMPT (editor-hosts-agent tooling; not a project mutation) |

### Input settings
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Edit actions / axes / gamepad mappings, deadzone, threshold | (updateSettings inputMappings) | `update_settings` / `set_input_mapping` | ✓ |

### Game Settings
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Window / loop / fixed-timestep / loading visuals / shipping icon / title / colors / spinner / initial scene | (updateSettings) | `update_settings` | ✓ (buildSettings deep-merge + initialScene + loading visuals) |

### Live panel
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Runtime inspection (transform/velocity/timers/tweens/events) | — | — | EXEMPT (runtime view; agent analog = `run_playtest` asserts + `screenshot`) |

### Animator
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Create state-machine asset | `create asset state-machine` | `create_state_machine_asset` | ✓ |
| Edit params/states/transitions (add/remove/**reorder**/type/conditions) | `set-state-machine` | `update_state_machine_asset` | ✓ MORE (full-array replace — agent can reorder transitions; editor cannot yet — L-085) |
| Save flow, dirty pill | — | — | EXEMPT (editor persistence) |

### Export dialog
| Editor capability | CLI | MCP | Status |
|---|---|---|---|
| Web export (folder / single HTML / zip) | `export web` | `export_web` | ✓ |
| Desktop export (platforms, signing) | `export desktop` | `export_desktop` | ✓ |
| Headless build | (buildProject) | `build_project` | ✓ (agent surface; editor uses export) |
| Reveal-in-folder, reopen persistence | — | — | EXEMPT (chrome) |

---

## Reverse direction — commands with no (or partial) editor surface

Agents-first is explicitly sanctioned (spec Phase 2b). These are *not* gaps —
listed for completeness.

| Command / tool | Editor surface? | Note |
|---|---|---|
| `create_playtest` / `list_playtests` / `run_playtest` | none | Agents-first: authored playtests are the agent's verification loop; no editor playtest runner. |
| `run_scene` (runSceneSmoke) | none | Agents-first headless smoke. |
| `build_project` | partial (Export dialog) | Headless build; editor reaches it via export. |
| `inspect_api` (inspectApi) | partial (Code hover docs) | Full ctx reference is agent-facing. |
| `inspect_path` / `inspect_scene` / `inspect_entity` / `list_*` | editor renders equivalents | Read-only; agent JSON views. |
| `screenshot` (MCP + CLI special) | none | Agent visual verification; editor renders live. |
| `set_properties` (batch) | per-field only | Batch is an agent convenience. |
| `snapshot_project` / `list_journal` / `list_history` | Changes/Agent panels | Present both sides. |
| **`setAssetMetadata`** (core cmd #71) | **none** | Registry command reachable via **neither** CLI nor MCP and with **no** editor surface — an orphan (generic metadata merge; slice/anim flows set metadata through their own commands). Not a parity gap (no editor capability to match); optional small-closure if agent tooling completeness is wanted (see below). |

---

## Summary

**Parity is strong.** Of ~55 game-affecting editor capabilities walked, all but
two are already reachable via both CLI and MCP; several agent surfaces are *more*
capable than the editor (createSound, createStateMachineAsset, removeAsset,
transition reorder). The only true parity gaps are **two existing core commands
that were never surfaced on CLI or MCP.**

### Gap count: **2 true parity gaps** (+1 orphan command, +2 forward-dependencies)

The `71 commands / 68 MCP tools` delta is exactly these three unsurfaced core
commands: `setEntityEnabled`, `setEntityTags`, `setAssetMetadata`. The first two
back real editor capabilities (parity gaps); the third backs none (orphan).

### Small-closure list (fits Wave L anti-bloat — surface existing commands, NO new core commands)

1. **`setEntityEnabled` parity** — enable/disable an entity.
   - Editor: Inspector "Enabled" checkbox (verified working, inspector-core).
   - Agent today: cannot toggle enabled at all (no CLI subcommand, no MCP tool).
   - Closure shape: MCP tool `set_entity_enabled { scene, entity, enabled }`
     (add to `TOOL_SPECS`); CLI `hearth set enabled <scene> <entity> <true|false>`
     (or an `entity enable|disable` pair) → both dispatch the existing
     `setEntityEnabled` command. Pure surface plumbing.

2. **`setEntityTags` parity** — set/replace an entity's tags after creation.
   - Editor: Inspector "Tags" field (verified working, inspector-core).
   - Agent today: can only set tags at *creation* (`create entity --tags`); no
     post-create path on CLI, none on MCP.
   - Closure shape: MCP tool `set_entity_tags { scene, entity, tags: string[] }`;
     CLI `hearth set tags <scene> <entity> <a,b,c>` → dispatch existing
     `setEntityTags`. Pure surface plumbing.

   *(1 and 2 are one T8 batch — same file-set: `tools.ts` + `program.ts`, no core
   change. Also add a docs-accuracy test row so SKILL.md can reference them.)*

3. **`setAssetMetadata` surface (optional, completeness only)** — NOT required by
   parity (no editor surface). If agent-tooling completeness is desired, add MCP
   `set_asset_metadata { asset, metadata }` + CLI `hearth set asset-metadata`.
   Recommend **skip in Wave L** unless the SKILL.md workflow needs it — leaving a
   registry command unreachable is a latent smell but not a parity obligation.

### Defer-to-M list (need a new command / design — anti-bloat says not now)

1. **`renameAsset`** — no command exists anywhere; editor can't rename assets
   today either (L-044 open), so **no current parity gap**. But T9/U3 is slated
   to add asset rename UI. If it lands, a new `renameAsset` command is required
   (must rewrite the on-disk path + update every reference + journal it) — that's
   design work, defer to M. **Recommendation: scope L-044's Wave-L delivery to
   delete-only (backed by existing `removeAsset`)** and hold rename/duplicate for
   M so the editor never ships an asset op the agent can't mirror.

2. **`duplicateAsset`** — same story as rename: no command, editor lacks it too
   (L-044). New command + design (clone file on disk, fresh id) → defer to M.

### Ledger entries to file (T16 Step 1 → feed T8)

Append to `LEDGER.md` (next free id is L-111):

- **L-111 · parity · defect · med** — `setEntityEnabled` unreachable via CLI/MCP
  (editor Inspector can, agent cannot). Small-closure: surface existing command
  as `set_entity_enabled` (MCP) + `set enabled` (CLI). Disposition: open.
- **L-112 · parity · defect · med** — `setEntityTags` unreachable via CLI/MCP
  post-creation (editor Inspector can, agent can only set at create). Small-
  closure: surface existing command as `set_entity_tags` (MCP) + `set tags`
  (CLI). Disposition: open.

Both fixable in T8 as one batch (`tools.ts` + `program.ts`, no core touch), which
keeps the `71/68` counts moving toward `71/70` and satisfies the docs-accuracy
test the SKILL.md work (Step 2) will add.
