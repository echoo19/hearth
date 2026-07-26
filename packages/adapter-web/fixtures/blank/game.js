/*
 * Blank fixture: paints one static color and listens to nothing. No probe
 * shim, no game state, no way in. The adapter must still open it, screenshot
 * it, watch for errors — and honestly report that it can do nothing else.
 */
(function () {
  'use strict';
  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b3350';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
})();
