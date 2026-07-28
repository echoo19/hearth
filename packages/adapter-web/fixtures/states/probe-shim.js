/*
 * Hearth probe shim — reference implementation, v1.
 *
 * Copy this file into your game and load it BEFORE your game code:
 *
 *     <script src="probe-shim.js"></script>
 *     <script src="game.js"></script>
 *
 * Then tell it how to read your world (all hooks optional):
 *
 *     window.__hearthProbe.configure({
 *       actions: ['left', 'right', 'jump'],
 *       scene: function () { return currentLevel.name; },
 *       entities: function () {
 *         return [
 *           { id: 'player', name: 'player', tags: ['player'],
 *             x: player.x, y: player.y, alive: player.hp > 0 },
 *           { id: 'goal', name: 'goal', tags: ['objective'],
 *             x: goal.x, y: goal.y, alive: !goal.taken },
 *         ];
 *       },
 *       navGrid: function () {
 *         return { originX: 0, originY: 0, cellSize: 32,
 *                  cols: level.cols, rows: level.rows,
 *                  solid: level.tiles.map(function (t) { return t.blocks; }) };
 *       },
 *       reset: function () { startLevel(currentLevel.name); },
 *     });
 *
 * If your game can jump straight to a situation, say which ones and how. The
 * names are yours and nothing outside your game reads them for meaning, so a
 * situation can be anything you can restore. A management sim might offer:
 *
 *     window.__hearthProbe.configure({
 *       listStates: function () {
 *         return [
 *           { id: 'y1-spring', label: 'Year one, the spring intake' },
 *           { id: 'y3-deficit', label: 'Year three, already in deficit',
 *             detail: 'two departments unstaffed' },
 *         ];
 *       },
 *       enterState: function (id) { loadScenario(id); },
 *     });
 *
 * Give both or neither: a list nothing can act on does not turn the capability
 * on. Your tester is told these exist and may ask for one, and anything it
 * sees after being put somewhere is reported as placed rather than reached, so
 * a finding from here never passes itself off as proof a player can get there.
 *
 * ...and announce interesting moments as they happen:
 *
 *     window.__hearthProbe.emit('jump');
 *
 * Which hooks you provide decides WHICH BOTS CAN PLAY:
 *
 *   nothing             idle and mash. mash presses buttons at random: it can
 *                       find a crash, but it cannot get anywhere on purpose.
 *   entities            seek plays. It steers straight at the entity you tagged
 *                       'objective' (or at a target the caller names) and mashes
 *                       when it stops getting closer. No pathfinding, so it will
 *                       not solve a maze or get around a C-shaped wall.
 *   entities + navGrid  seek paths to its target instead of walking at it, and
 *                       wander explores the walkable cells it has not seen yet.
 *                       Sealed-off regions get reported too.
 *
 * This is code you own, not a dependency: no build step, no imports, no
 * framework, and it does nothing at all unless a probe reads it. Every hook
 * is called from outside your game loop, so all of them are wrapped: a hook
 * that throws degrades that one sense instead of breaking the probe.
 *
 * Full spec: docs/probe-shim.md in @hearth/adapter-web.
 */
(function (global) {
  'use strict';

  if (global.__hearthProbe && global.__hearthProbe.version === 1) return;

  /* Bounded so a chatty game can never grow the buffer without limit. */
  var MAX_EVENTS = 512;
  var MAX_ENTITIES = 512;
  var MAX_STATES = 256;

  var events = [];
  var probe = { version: 1 };

  /** Record a named game event. Cheap enough to call from the game loop. */
  probe.emit = function emit(name) {
    if (typeof name !== 'string' || !name) return;
    if (events.length >= MAX_EVENTS) events.shift();
    events.push(name);
  };

  /** Hand over every event since the last drain, and start a fresh buffer. */
  probe.drainEvents = function drainEvents() {
    var drained = events;
    events = [];
    return drained;
  };

  function toEntity(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    var x = Number(raw.x);
    var y = Number(raw.y);
    if (!isFinite(x) || !isFinite(y)) return null;
    var entity = {
      id: String(raw.id != null ? raw.id : raw.name != null ? raw.name : 'entity' + index),
      x: x,
      y: y,
      alive: raw.alive === undefined ? true : !!raw.alive,
    };
    if (typeof raw.name === 'string') entity.name = raw.name;
    if (Array.isArray(raw.tags)) {
      var tags = [];
      for (var i = 0; i < raw.tags.length; i++) {
        if (typeof raw.tags[i] === 'string') tags.push(raw.tags[i]);
      }
      entity.tags = tags;
    }
    return entity;
  }

  function wrapScene(fn) {
    return function scene() {
      try {
        var value = fn();
        return value == null ? null : String(value);
      } catch (err) {
        return null;
      }
    };
  }

  function wrapEntities(fn) {
    return function entities() {
      var list;
      try {
        list = fn();
      } catch (err) {
        return [];
      }
      if (!Array.isArray(list)) return [];
      var out = [];
      for (var i = 0; i < list.length && out.length < MAX_ENTITIES; i++) {
        var entity = toEntity(list[i], i);
        if (entity) out.push(entity);
      }
      return out;
    };
  }

  function wrapNavGrid(fn) {
    return function navGrid() {
      var grid;
      try {
        grid = fn();
      } catch (err) {
        return null;
      }
      if (!grid || typeof grid !== 'object') return null;
      var cols = Number(grid.cols);
      var rows = Number(grid.rows);
      var cellSize = Number(grid.cellSize);
      if (!(cols > 0) || !(rows > 0) || !(cellSize > 0)) return null;
      if (!Array.isArray(grid.solid) || grid.solid.length !== cols * rows) return null;
      var solid = [];
      for (var i = 0; i < grid.solid.length; i++) solid.push(!!grid.solid[i]);
      return {
        originX: Number(grid.originX) || 0,
        originY: Number(grid.originY) || 0,
        cellSize: cellSize,
        cols: cols,
        rows: rows,
        solid: solid,
      };
    };
  }

  function wrapReset(fn) {
    return function reset() {
      events = [];
      try {
        fn();
      } catch (err) {
        /* a broken reset hook must not kill the probe run */
      }
    };
  }

  /**
   * The situations this game can be put into, and putting it into one.
   *
   * The names are yours. Nothing outside your game reads them for meaning, so
   * whatever a "situation" is here is up to you: a quarter, a save slot, a
   * squad composition, a point on a clock.
   */
  function wrapListStates(fn) {
    return function listStates() {
      var list;
      try {
        list = fn();
      } catch (err) {
        return [];
      }
      if (!Array.isArray(list)) return [];
      var out = [];
      for (var i = 0; i < list.length && out.length < MAX_STATES; i++) {
        var raw = list[i];
        if (!raw || typeof raw !== 'object') continue;
        var id = raw.id == null ? '' : String(raw.id);
        if (!id) continue;
        var state = { id: id, label: raw.label == null ? id : String(raw.label) };
        if (raw.detail != null) state.detail = String(raw.detail);
        out.push(state);
      }
      return out;
    };
  }

  function wrapEnterState(fn) {
    return function enterState(id) {
      events = [];
      try {
        fn(String(id));
      } catch (err) {
        /* a broken hook must not kill the probe run */
      }
    };
  }

  function stringList(value) {
    if (!Array.isArray(value)) return null;
    var out = [];
    for (var i = 0; i < value.length; i++) {
      if (typeof value[i] === 'string') out.push(value[i]);
    }
    return out;
  }

  /**
   * Install hooks. Call it once at startup, or repeatedly — later calls
   * replace only the fields they pass. A hook is *advertised to the probe
   * only when you provide it*, which is what keeps capability reporting
   * honest: no hook, no claimed sense.
   */
  probe.configure = function configure(spec) {
    if (!spec || typeof spec !== 'object') return probe;
    if (typeof spec.scene === 'function') probe.scene = wrapScene(spec.scene);
    if (typeof spec.entities === 'function') probe.entities = wrapEntities(spec.entities);
    if (typeof spec.navGrid === 'function') probe.navGrid = wrapNavGrid(spec.navGrid);
    if (typeof spec.reset === 'function') probe.reset = wrapReset(spec.reset);
    // Both or neither. A list of places a probe cannot be put is a menu, not a
    // capability, so half of the pair is declared as none of it.
    if (typeof spec.listStates === 'function' && typeof spec.enterState === 'function') {
      probe.listStates = wrapListStates(spec.listStates);
      probe.enterState = wrapEnterState(spec.enterState);
    }
    var actions = stringList(spec.actions);
    if (actions) probe.actions = actions;
    var axes = stringList(spec.axes);
    if (axes) probe.axes = axes;
    return probe;
  };

  global.__hearthProbe = probe;
})(typeof window !== 'undefined' ? window : globalThis);
