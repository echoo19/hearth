/**
 * Command registry: the canonical list of every Hearth operation.
 * CLI commands, MCP tools, and editor actions are all generated from /
 * dispatched through this table.
 */
import type { CommandDefinition } from './types.js';

import * as sceneCommands from './sceneCommands.js';
import * as entityCommands from './entityCommands.js';
import * as componentCommands from './componentCommands.js';
import * as tilemapCommands from './tilemapCommands.js';
import * as inspectCommands from './inspectCommands.js';
import * as scriptCommands from './scriptCommands.js';
import * as assetCommands from './assetCommands.js';
import * as prefabCommands from './prefabCommands.js';
import * as settingsCommands from './settingsCommands.js';
import * as diffCommands from './diffCommands.js';
import * as exportCommands from './exportCommands.js';
import * as historyCommands from './historyCommands.js';
import * as journalCommands from './journalCommands.js';

const ALL_DEFINITIONS: CommandDefinition[] = [
  // inspect (read-only)
  inspectCommands.inspectProject,
  inspectCommands.listScenes,
  inspectCommands.inspectScene,
  inspectCommands.inspectEntity,
  inspectCommands.inspectComponents,
  inspectCommands.inspectAssets,
  inspectCommands.inspectScripts,
  inspectCommands.readScript,
  inspectCommands.inspectApi,
  inspectCommands.validateProjectCommand,
  inspectCommands.inspectPath,
  // scenes
  sceneCommands.createScene,
  sceneCommands.deleteScene,
  sceneCommands.duplicateScene,
  sceneCommands.renameScene,
  sceneCommands.setInitialScene,
  // entities
  entityCommands.createEntity,
  entityCommands.deleteEntity,
  entityCommands.duplicateEntity,
  entityCommands.renameEntity,
  entityCommands.moveEntity,
  entityCommands.setEntityEnabled,
  entityCommands.setEntityTags,
  // components
  componentCommands.addComponent,
  componentCommands.removeComponent,
  componentCommands.setComponentProperty,
  componentCommands.setInputMapping,
  // tilemap
  tilemapCommands.paintTiles,
  tilemapCommands.fillTilemapRect,
  tilemapCommands.resizeTilemap,
  // scripts
  scriptCommands.createScript,
  scriptCommands.editScript,
  scriptCommands.attachScript,
  // assets
  assetCommands.importAsset,
  assetCommands.createSpriteAsset,
  assetCommands.createTileAsset,
  assetCommands.createAnimationAsset,
  assetCommands.createSound,
  assetCommands.setAssetMetadata,
  assetCommands.removeAsset,
  assetCommands.sliceSpritesheet,
  assetCommands.createAnimationFromSheet,
  // prefabs
  prefabCommands.createPrefab,
  prefabCommands.instantiatePrefab,
  // settings
  settingsCommands.updateSettings,
  // diff / playtest / build
  diffCommands.snapshotProject,
  diffCommands.diffProject,
  diffCommands.revertProject,
  diffCommands.createPlaytest,
  diffCommands.listPlaytests,
  diffCommands.runPlaytest,
  diffCommands.runSceneSmoke,
  diffCommands.buildProject,
  exportCommands.exportWeb,
  // history (undo/redo)
  historyCommands.undo,
  historyCommands.redo,
  historyCommands.listHistory,
  // command journal
  journalCommands.listJournal,
];

export const COMMANDS: ReadonlyMap<string, CommandDefinition> = new Map(
  ALL_DEFINITIONS.map((d) => [d.name, d]),
);

export function getCommand(name: string): CommandDefinition | undefined {
  return COMMANDS.get(name);
}

export function listCommands(): { name: string; description: string; permission: string; mutates: boolean }[] {
  return ALL_DEFINITIONS.map((d) => ({
    name: d.name,
    description: d.description,
    permission: d.permission,
    mutates: d.mutates,
  }));
}
