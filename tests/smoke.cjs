'use strict';

// Run from any directory: node /path/to/tank-battle/tests/smoke.cjs
// A fixed clock and seeded RNG exercise gameplay without a browser or packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
let passed = 0;

function fixture({ automaticSpawns = false, storageDisabled = false } = {}) {
  let seed = 1985, frameId = 0, time = 0;
  const frames = new Map(), storage = new Map(), listeners = new Map();
  const randomMath = Object.create(Math);
  randomMath.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const context = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) }, {
    get: (target, key) => target[key] ?? (() => {}),
    set: (target, key, value) => { target[key] = value; return true; }
  });
  const document = {
    hidden: false,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name)
  };
  const sandbox = {
    window: {}, document, Math: randomMath,
    localStorage: {
      getItem(key) { if (storageDisabled) throw new Error('Storage denied'); return storage.get(key); },
      setItem(key, value) { if (storageDisabled) throw new Error('Storage denied'); storage.set(key, value); }
    },
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id)
  };
  vm.runInNewContext(source, sandbox, { filename: 'game.js' });
  const states = [], events = [], ends = [];
  const canvas = { getContext: () => context };
  const game = new sandbox.window.TankGame(canvas, {
    onState: state => states.push(state),
    onEvent: event => events.push(event),
    onEnd: result => ends.push(result)
  });
  assert.equal(states.length, 0, 'construction must not invoke callbacks before UI is ready');
  game.start();
  if (!automaticSpawns) game.spawnClock = 1e6;
  function advance(seconds) {
    const count = Math.ceil(seconds / 0.02);
    for (let step = 0; step < count; step++) {
      time += 20;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    }
  }
  // Prime the first animation frame; subsequent frames each advance 20 ms.
  advance(0.02);
  return { game, canvas, states, events, ends, storage, document, listeners, frames, advance };
}

function test(name, run) {
  run();
  passed++;
  console.log('PASS ' + name);
}

function shot(f) {
  f.game.setInput('fire', true);
  f.advance(0.02);
  f.game.setInput('fire', false);
}

function enemyBulletAtPlayer(f) {
  const player = f.game.player;
  f.game.bullets.push({ x: player.x, y: player.y - 25, w: 5, h: 5, dx: 0, dy: 1, speed: 260, side: 'enemy', alive: true });
}

test('starts at 720x600 with three lives and eight enemies; directional controls move the tank', () => {
  const f = fixture();
  assert.equal(f.canvas.width, 720);
  assert.equal(f.canvas.height, 600);
  assert.equal(f.states.at(-1).lives, 3);
  assert.equal(f.states.at(-1).enemiesRemaining, 8);
  const y = f.game.player.y;
  f.game.setInput('up', true);
  f.advance(0.2);
  f.game.setInput('up', false);
  assert.ok(f.game.player.y < y - 20, 'holding up must move visibly');
  const stopped = f.game.player.y;
  f.advance(0.2);
  assert.equal(f.game.player.y, stopped, 'releasing a control must stop movement');
  shot(f);
  assert.equal(f.game.bullets.length, 1);
});

test('brick blocks tank movement and is destructible by shells', () => {
  const f = fixture();
  Object.assign(f.game.player, { x: 105, y: 205, dir: 'up' });
  f.game.setInput('up', true);
  f.advance(0.4);
  f.game.setInput('up', false);
  assert.ok(f.game.player.y >= 191, 'tank must stop outside the brick');
  assert.equal(f.game.map[5][3], 1);
  shot(f);
  f.advance(0.12);
  assert.equal(f.game.map[5][3], 0, 'shell must clear the hit brick tile');
});

test('steel remains intact and stops shells', () => {
  const f = fixture();
  Object.assign(f.game.player, { x: 195, y: 270, dir: 'up' });
  shot(f);
  f.advance(0.2);
  assert.equal(f.game.map[7][6], 2);
  assert.equal(f.game.bullets.length, 0, 'shell must not pass through steel');
});

test('hitting an enemy destroys it, adds points and persists the highest score', () => {
  const f = fixture();
  assert.equal(f.game.spawnEnemy(), true);
  Object.assign(f.game.enemies[0], { x: 285, y: 465, speed: 0, cooldown: 99 });
  f.game.player.dir = 'up';
  shot(f);
  f.advance(0.35);
  assert.equal(f.game.enemies.length, 0);
  assert.equal(f.game.kills, 1);
  assert.equal(f.states.at(-1).score, 100);
  assert.equal(f.storage.get('tank-frontline-high-score'), '100');
  f.game.restart();
  assert.equal(f.game.score, 0);
  assert.equal(f.game.kills, 0);
  assert.equal(f.game.lives, 3);
  assert.equal(f.game.bullets.length, 0);
  assert.equal(f.game.highScore, 100, 'restart must retain the best score');
});

test('friendly fire leaves the command post intact', () => {
  const f = fixture();
  f.game.map[17][12] = 0;
  Object.assign(f.game.player, { x: 375, y: 500, dir: 'down' });
  shot(f);
  f.advance(0.2);
  assert.equal(f.game.base.alive, true);
  assert.equal(f.game.running, true);
  assert.equal(f.ends.length, 0);
});

test('an enemy shell hitting the command post ends the battle exactly once', () => {
  const f = fixture();
  f.game.map[17][12] = 0;
  f.game.bullets.push({ x: 375, y: 525, w: 5, h: 5, dx: 0, dy: 1, speed: 260, side: 'enemy', alive: true });
  f.advance(0.3);
  assert.equal(f.game.base.alive, false);
  assert.equal(f.game.running, false);
  assert.equal(f.ends.length, 1);
  assert.equal(f.ends[0].victory, false);
  f.advance(1);
  assert.equal(f.ends.length, 1);
});

test('a destroyed tank respawns with a shield; exhausting all lives ends the game', () => {
  const f = fixture();
  for (let life = 3; life > 0; life--) {
    f.game.player.shield = 0;
    enemyBulletAtPlayer(f);
    f.advance(0.2);
    assert.equal(f.game.lives, life - 1);
    assert.equal(f.game.player.alive, false);
    if (life > 1) {
      f.advance(1.5);
      assert.equal(f.game.player.alive, true);
      assert.ok(f.game.player.shield > 3, 'redeployment must protect the tank briefly');
    }
  }
  assert.equal(f.ends.length, 1);
  assert.equal(f.ends[0].victory, false);
  assert.equal(f.game.base.alive, true, 'life exhaustion must work independently of base loss');
});

test('pause freezes play and clears held controls; hiding the tab pauses play', () => {
  const f = fixture();
  f.game.setInput('up', true);
  f.game.setInput('fire', true);
  f.advance(0.06);
  const y = f.game.player.y;
  f.game.togglePause();
  f.advance(1);
  assert.equal(f.game.player.y, y);
  f.game.setInput('down', true);
  f.game.togglePause();
  f.advance(0.2);
  assert.equal(f.game.player.y, y, 'controls held before or during pause must not stick');
  f.document.hidden = true;
  f.listeners.get('visibilitychange')();
  assert.equal(f.game.paused, true);
  f.game.destroy();
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('shield, rapid-fire and repair supplies apply when the tank touches them', () => {
  const f = fixture();
  function collect(kind) {
    const { x, y } = f.game.player;
    f.game.pickups.push({ x, y, w: 24, h: 24, kind, life: 15 });
    f.advance(0.02);
    assert.equal(f.game.pickups.length, 0, 'collected supply must disappear');
  }
  f.game.player.shield = 0;
  collect('shield');
  assert.ok(f.game.player.shield >= 8.9);
  enemyBulletAtPlayer(f);
  f.advance(0.15);
  assert.equal(f.game.lives, 3, 'shield must absorb incoming fire');
  collect('rapid');
  assert.ok(f.game.player.rapid > 11);
  f.game.setInput('fire', true);
  f.advance(0.5);
  f.game.setInput('fire', false);
  assert.ok(f.game.bullets.length >= 3, 'rapid fire must allow at least three shells in half a second');
  f.game.lives = 1;
  f.game.map[17][12] = 0;
  collect('repair');
  assert.equal(f.game.lives, 2);
  assert.equal(f.game.map[17][12], 1, 'repair must restore a destroyed defensive wall');
});

test('clearing a wave advances to the next; clearing wave three awards the survival bonus', () => {
  const f = fixture();
  f.game.spawned = f.game.waveTotal;
  f.advance(3.2);
  assert.equal(f.game.wave, 2);
  assert.equal(f.states.at(-1).wave, 2);
  assert.equal(f.game.waveTotal, 10);
  f.game.wave = 3;
  f.game.waveTotal = f.game.spawned = 12;
  f.game.enemies = [];
  f.game.score = 1200;
  f.game.lives = 2;
  f.advance(0.02);
  assert.equal(f.ends.length, 1);
  assert.equal(f.ends[0].victory, true);
  assert.equal(f.ends[0].score, 2200, 'surviving lives must grant their end-of-battle bonus');
  assert.equal(f.game.running, false);
});

test('enemy AI navigates the battlefield during a seeded fixed-step battle', () => {
  const f = fixture({ automaticSpawns: true });
  f.advance(2);
  assert.ok(f.game.enemies.length > 0);
  f.advance(6);
  assert.ok(f.game.enemies.some(enemy => enemy.y > 100), 'enemies must advance from the top spawn lanes');
  f.game.setInput('fire', true);
  f.advance(50);
  assert.ok(Number.isFinite(f.game.player.x) && Number.isFinite(f.game.player.y));
  assert.ok(f.game.enemies.every(enemy => Number.isFinite(enemy.x) && Number.isFinite(enemy.y)));
  assert.ok(f.ends.length <= 1);
});

test('blocked browser storage does not prevent playing or scoring', () => {
  const f = fixture({ storageDisabled: true });
  assert.equal(f.game.spawnEnemy(), true);
  Object.assign(f.game.enemies[0], { x: 285, y: 465, speed: 0, cooldown: 99 });
  shot(f);
  f.advance(0.35);
  assert.equal(f.game.score, 100);
  assert.equal(f.game.running, true);
});

console.log('\n' + passed + ' deterministic gameplay smoke tests passed.');
