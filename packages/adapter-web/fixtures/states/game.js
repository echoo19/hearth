/*
 * States fixture: a game with no levels, no avatar and no map.
 *
 * A small bureau sim, on purpose. The states are a year, a budget and an
 * audit week, so a test that passes here cannot be passing because the
 * adapter quietly assumes a list of platformer levels.
 *
 * ?variant= selects how much the game cooperates:
 *   full       (default) lists its states and can be put into one
 *   list-only  lists them but cannot be put into any
 *   no-states  a shim with neither hook
 */
(function () {
  'use strict';

  var VARIANT = new URLSearchParams(location.search).get('variant') || 'full';

  var STATES = [
    { id: 'y1-spring', label: 'Year one, the spring intake' },
    { id: 'y3-deficit', label: 'Year three, already in deficit', detail: 'two departments unstaffed' },
    { id: 'audit', label: 'The week of the audit' },
  ];

  var current = 'y1-spring';

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');

  function draw() {
    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e8e2d8';
    ctx.font = '28px sans-serif';
    ctx.fillText(current, 40, 80);
    requestAnimationFrame(draw);
  }
  draw();

  var spec = {
    scene: function () {
      return current;
    },
  };
  if (VARIANT !== 'no-states') {
    spec.listStates = function () {
      return STATES;
    };
  }
  if (VARIANT === 'full') {
    spec.enterState = function (id) {
      current = id;
    };
  }
  window.__hearthProbe.configure(spec);
})();
