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
 *         return [{ id: 'player', name: 'player', tags: ['player'],
 *                   x: player.x, y: player.y, alive: player.hp > 0 }];
 *       },
 *       reset: function () { startLevel(currentLevel.name); },
 *     });
 *
 * ...and announce interesting moments as they happen:
 *
 *     window.__hearthProbe.emit('jump');
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
    var actions = stringList(spec.actions);
    if (actions) probe.actions = actions;
    var axes = stringList(spec.axes);
    if (axes) probe.axes = axes;
    return probe;
  };

  global.__hearthProbe = probe;
})(typeof window !== 'undefined' ? window : globalThis);
