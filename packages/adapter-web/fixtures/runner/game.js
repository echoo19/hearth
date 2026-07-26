/*
 * Runner fixture: the smallest game that can be broken in interesting ways.
 *
 * Ground, a pit, a goal flag. ArrowRight walks, Space jumps. No RNG, fixed
 * timestep, no assets — the same inputs produce the same run.
 *
 * ?variant= selects the failure under test:
 *   healthy       (default) crossable pit, reachable goal
 *   broken-jump   Space does nothing, so the pit is impassable
 *   pit-softlock  falling in the pit freezes the player forever
 *   crash         touching the pit edge throws an uncaught TypeError
 */
(function () {
  'use strict';

  var VARIANT = new URLSearchParams(location.search).get('variant') || 'healthy';

  var GROUND_Y = 400;
  var PIT_START = 320;
  var PIT_END = 400;
  var GOAL_X = 700;
  var WORLD_RIGHT = 936;
  var SPEED = 220;
  var GRAVITY = 1400;
  var JUMP_V = 520;
  var DT = 1 / 60;

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');

  var player = { x: 60, y: GROUND_Y - 32, w: 24, h: 32, vy: 0, grounded: true };
  var frozen = false;
  var won = false;
  var scene = 'level1';
  var keys = Object.create(null);

  addEventListener('keydown', function (e) {
    keys[e.code] = true;
    if (e.code === 'Space' || e.code.indexOf('Arrow') === 0) e.preventDefault();
  });
  addEventListener('keyup', function (e) {
    keys[e.code] = false;
  });

  function emit(name) {
    if (window.__hearthProbe) window.__hearthProbe.emit(name);
  }

  function overPit(x) {
    return x + player.w > PIT_START && x < PIT_END;
  }

  function respawn() {
    player.x = 60;
    player.y = GROUND_Y - player.h;
    player.vy = 0;
    player.grounded = true;
    emit('respawn');
  }

  function restart() {
    respawn();
    frozen = false;
    won = false;
    scene = 'level1';
  }

  function update() {
    if (frozen) return;

    if (VARIANT === 'crash' && player.x + player.w >= PIT_START - 8) {
      // A plausible shape of real bug: an object that isn't there yet.
      var tile = null;
      tile.solid = true;
    }

    if (!won) {
      if (keys.ArrowRight) player.x += SPEED * DT;
      if (keys.ArrowLeft) player.x -= SPEED * DT;
      if (player.x < 0) player.x = 0;
      if (player.x > WORLD_RIGHT) player.x = WORLD_RIGHT;

      if (keys.Space && player.grounded && VARIANT !== 'broken-jump') {
        player.vy = -JUMP_V;
        player.grounded = false;
        emit('jump');
      }
    }

    var prevBottom = player.y + player.h;
    player.vy += GRAVITY * DT;
    player.y += player.vy * DT;

    // Land only when coming down onto ground the player was above: without
    // the prevBottom check, walking right while falling through the pit would
    // pop the player back up onto the far ledge.
    var onSolidGround = !overPit(player.x);
    if (
      onSolidGround &&
      player.vy >= 0 &&
      prevBottom <= GROUND_Y + 0.001 &&
      player.y + player.h >= GROUND_Y
    ) {
      player.y = GROUND_Y - player.h;
      player.vy = 0;
      player.grounded = true;
    } else if (!onSolidGround || player.y + player.h < GROUND_Y) {
      player.grounded = false;
    }

    if (player.y > GROUND_Y + 60) {
      if (VARIANT === 'pit-softlock') {
        // The bug: the fall never resolves. No death, no respawn, no input.
        frozen = true;
        player.y = GROUND_Y + 60;
        player.vy = 0;
      } else if (player.y > 600) {
        respawn();
      }
    }

    if (!won && player.x + player.w >= GOAL_X) {
      won = true;
      scene = 'cleared';
      emit('goal');
    }
  }

  function render() {
    ctx.fillStyle = won ? '#1d3a2b' : '#10131a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#3a4256';
    ctx.fillRect(0, GROUND_Y, PIT_START, canvas.height - GROUND_Y);
    ctx.fillRect(PIT_END, GROUND_Y, canvas.width - PIT_END, canvas.height - GROUND_Y);

    ctx.fillStyle = '#e0603a';
    ctx.fillRect(GOAL_X, GROUND_Y - 60, 6, 60);
    ctx.fillRect(GOAL_X + 6, GROUND_Y - 60, 28, 18);

    ctx.fillStyle = '#f2f0e6';
    ctx.fillRect(player.x, player.y, player.w, player.h);
  }

  function frame() {
    update();
    render();
    requestAnimationFrame(frame);
  }

  if (window.__hearthProbe) {
    window.__hearthProbe.configure({
      actions: ['left', 'right', 'jump'],
      scene: function () {
        return scene;
      },
      entities: function () {
        return [
          {
            id: 'player',
            name: 'player',
            tags: ['player', 'actor'],
            x: player.x + player.w / 2,
            y: player.y + player.h / 2,
            alive: true,
          },
          {
            id: 'goal',
            name: 'goal',
            tags: ['objective'],
            x: GOAL_X + 17,
            y: GROUND_Y - 30,
            alive: !won,
          },
        ];
      },
      reset: restart,
    });
  }

  render();
  requestAnimationFrame(frame);
})();
