/* Tank Frontline — standalone Canvas game engine, no external dependencies. */
(function () {
  'use strict';

  const TILE = 30, COLS = 24, ROWS = 20, WIDTH = COLS * TILE, HEIGHT = ROWS * TILE;
  const DIRS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  const ANGLES = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 };
  const STORAGE_KEY = 'tank-frontline-high-score';
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const random = (a, b) => a + Math.random() * (b - a);
  const overlap = (a, b, padding = 0) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 - padding && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - padding;

  class TankGame {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.canvas.width = WIDTH;
      this.canvas.height = HEIGHT;
      this.ctx.imageSmoothingEnabled = false;
      this.onState = options.onState || (() => {});
      this.onEvent = options.onEvent || (() => {});
      this.onEnd = options.onEnd || (() => {});
      this.highScore = 0;
      try { this.highScore = Number(localStorage.getItem(STORAGE_KEY)) || 0; } catch (_) { /* Storage is optional. */ }
      this.muted = false;
      this.audio = null;
      this.running = false;
      this.paused = false;
      this.input = Object.create(null);
      this.directionOrder = [];
      this.frame = 0;
      this.lastTime = 0;
      this.stateClock = 0;
      this.resetWorld();
      this.draw();
      this.boundFrame = time => this.tick(time);
      this.visibilityHandler = () => {
        if (document.hidden && this.running && !this.paused) this.togglePause();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    resetWorld() {
      this.map = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
      // 0: ground, 1: brick, 2: steel, 3: water, 4: canopy.
      const rect = (c, r, w, h, kind) => {
        for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) this.map[y][x] = kind;
      };
      [[3, 3], [7, 3], [15, 3], [19, 3], [3, 8], [9, 8], [15, 8], [20, 8], [3, 13], [7, 13], [15, 13], [19, 13]].forEach(([c, r]) => rect(c, r, 2, 3, 1));
      rect(10, 3, 4, 1, 1);
      rect(10, 4, 1, 2, 1);
      rect(13, 4, 1, 2, 1);
      rect(6, 7, 2, 1, 2);
      rect(17, 7, 2, 1, 2);
      rect(11, 11, 2, 2, 2);
      rect(2, 11, 3, 1, 3);
      rect(19, 11, 3, 1, 3);
      rect(6, 10, 2, 2, 4);
      rect(16, 10, 2, 2, 4);
      rect(10, 14, 4, 2, 4);
      rect(1, 16, 3, 1, 4);
      rect(20, 16, 3, 1, 4);
      this.restoreBaseWalls();
      this.base = { x: 375, y: 555, w: 26, h: 26, alive: true };
      this.player = this.makePlayer();
      this.enemies = [];
      this.bullets = [];
      this.particles = [];
      this.pickups = [];
      this.score = 0;
      this.kills = 0;
      this.lives = 3;
      this.wave = 1;
      this.waveTotal = 8;
      this.spawned = 0;
      this.spawnClock = 1.25;
      this.waveClock = 0;
      this.respawnClock = 0;
      this.elapsed = 0;
      this.shake = 0;
      this.flash = 0;
      this.banner = '';
      this.bannerClock = 0;
    }

    restoreBaseWalls() {
      for (const r of [17, 19]) for (let c = 11; c <= 13; c++) this.map[r][c] = 1;
      this.map[18][11] = 1;
      this.map[18][13] = 1;
    }

    makePlayer() {
      return { x: 285, y: 555, w: 23, h: 23, dir: 'up', cooldown: 0, shield: 3, rapid: 0, speed: 136, track: 0, alive: true };
    }

    start() {
      if (this.running) {
        if (this.paused) this.togglePause();
        return;
      }
      this.restart();
    }

    restart() {
      cancelAnimationFrame(this.frame);
      this.resetWorld();
      this.clearInput();
      this.running = true;
      this.paused = false;
      this.lastTime = 0;
      this.stateClock = 0;
      this.ensureAudio();
      this.showBanner('第 01 波 · 守住指挥部', 2.5);
      this.onEvent('战斗开始。守住基地，清除全部敌军。');
      this.emitState();
      this.frame = requestAnimationFrame(this.boundFrame);
    }

    togglePause() {
      if (!this.running) return false;
      this.paused = !this.paused;
      this.clearInput();
      this.lastTime = 0;
      if (!this.paused) this.ensureAudio();
      this.emitState();
      this.draw();
      return this.paused;
    }

    toggleMute() {
      this.muted = !this.muted;
      if (!this.muted && this.running) this.ensureAudio();
      this.emitState();
      return this.muted;
    }

    setInput(action, pressed) {
      if (!(action in DIRS) && action !== 'fire') return;
      if (pressed && (!this.running || this.paused)) return;
      if (action in DIRS) {
        if (pressed && !this.input[action]) this.directionOrder.push(action);
        if (!pressed) this.directionOrder = this.directionOrder.filter(dir => dir !== action);
      }
      this.input[action] = !!pressed;
    }

    clearInput() {
      this.input = Object.create(null);
      this.directionOrder = [];
    }

    emitState() {
      let powerup = '标准火力';
      if (this.player.shield > 0 && this.player.alive) powerup = '护盾 ' + Math.ceil(this.player.shield) + 's';
      else if (this.player.rapid > 0) powerup = '速射 ' + Math.ceil(this.player.rapid) + 's';
      this.onState({
        score: this.score, highScore: this.highScore, lives: this.lives, wave: this.wave,
        enemiesRemaining: Math.max(0, this.waveTotal - this.spawned) + this.enemies.length,
        kills: this.kills, paused: this.paused, running: this.running, muted: this.muted, powerup
      });
    }

    tick(time) {
      if (!this.running) return;
      const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.04) : 0;
      this.lastTime = time;
      if (!this.paused) this.update(dt);
      this.draw();
      if (this.running) this.frame = requestAnimationFrame(this.boundFrame);
    }

    update(dt) {
      this.elapsed += dt;
      this.shake = Math.max(0, this.shake - dt * 20);
      this.flash = Math.max(0, this.flash - dt * 3);
      this.bannerClock = Math.max(0, this.bannerClock - dt);
      this.updatePlayer(dt);
      this.updateEnemies(dt);
      this.updateBullets(dt);
      if (!this.running) return;
      this.updatePickups(dt);
      this.updateParticles(dt);
      this.updateWaves(dt);
      this.stateClock += dt;
      if (this.stateClock >= 0.12) { this.stateClock = 0; this.emitState(); }
    }

    updatePlayer(dt) {
      const player = this.player;
      if (!player.alive) {
        this.respawnClock -= dt;
        if (this.respawnClock <= 0 && this.lives > 0) {
          this.player = this.makePlayer();
          this.player.shield = 4;
          this.onEvent('坦克已重新部署，临时护盾生效。');
        }
        return;
      }
      player.cooldown = Math.max(0, player.cooldown - dt);
      player.shield = Math.max(0, player.shield - dt);
      player.rapid = Math.max(0, player.rapid - dt);
      const dir = this.directionOrder[this.directionOrder.length - 1];
      if (dir && this.input[dir]) {
        player.dir = dir;
        this.moveTank(player, DIRS[dir][0] * player.speed * dt, DIRS[dir][1] * player.speed * dt);
        player.track += dt * 28;
      }
      if (this.input.fire) this.shoot(player, 'player');
    }

    updateEnemies(dt) {
      for (const enemy of this.enemies) {
        enemy.cooldown = Math.max(0, enemy.cooldown - dt);
        enemy.planClock -= dt;
        if (enemy.planClock <= 0 || !enemy.waypoint) {
          enemy.planClock = random(0.5, 1.0);
          const target = this.player.alive && Math.random() < 0.32 ? this.player : this.base;
          enemy.waypoint = this.findWaypoint(enemy, target);
        }
        const wp = enemy.waypoint;
        let moving = false;
        if (wp) {
          const dx = wp.x - enemy.x, dy = wp.y - enemy.y;
          // Center on the route before turning so tanks fit one-tile corridors.
          if (Math.abs(dx) > 1.2 || Math.abs(dy) > 1.2) {
            const horizontal = Math.abs(dx) > Math.abs(dy);
            const amount = Math.min(enemy.speed * dt, Math.abs(horizontal ? dx : dy));
            enemy.dir = horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
            moving = this.moveTank(enemy, DIRS[enemy.dir][0] * amount, DIRS[enemy.dir][1] * amount);
            if (!moving) enemy.planClock = Math.min(enemy.planClock, 0.22);
          } else { enemy.waypoint = null; enemy.planClock = 0; }
        }
        if (moving) enemy.track += dt * 22;
        const aim = this.chooseAim(enemy);
        if (aim) enemy.dir = aim;
        if (enemy.cooldown <= 0) this.shoot(enemy, 'enemy');
      }
    }

    chooseAim(enemy) {
      for (const target of [this.player.alive ? this.player : null, this.base]) {
        if (!target || !target.alive) continue;
        const dx = target.x - enemy.x, dy = target.y - enemy.y;
        if (Math.abs(dx) < 15 && Math.abs(dy) < 390) return dy > 0 ? 'down' : 'up';
        if (Math.abs(dy) < 15 && Math.abs(dx) < 390) return dx > 0 ? 'right' : 'left';
      }
      return null;
    }

    findWaypoint(tank, target) {
      const sc = clamp(Math.floor(tank.x / TILE), 0, COLS - 1), sr = clamp(Math.floor(tank.y / TILE), 0, ROWS - 1);
      const gc = clamp(Math.floor(target.x / TILE), 0, COLS - 1), gr = clamp(Math.floor(target.y / TILE), 0, ROWS - 1);
      const start = sr * COLS + sc, goal = gr * COLS + gc;
      const costs = Array(COLS * ROWS).fill(Infinity), previous = Array(COLS * ROWS).fill(-1), open = [start], done = new Set();
      costs[start] = 0;
      while (open.length) {
        let best = 0;
        for (let i = 1; i < open.length; i++) if (costs[open[i]] < costs[open[best]]) best = i;
        const current = open.splice(best, 1)[0];
        if (done.has(current)) continue;
        if (current === goal) break;
        done.add(current);
        const c = current % COLS, r = Math.floor(current / COLS);
        for (const [dc, dr] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
          const kind = this.map[nr][nc];
          if (kind === 2 || kind === 3) continue;
          const next = nr * COLS + nc, cost = costs[current] + (kind === 1 ? 3.2 : 1);
          if (cost >= costs[next]) continue;
          costs[next] = cost;
          previous[next] = current;
          open.push(next);
        }
      }
      if (start === goal) return { x: gc * TILE + TILE / 2, y: gr * TILE + TILE / 2 };
      if (previous[goal] === -1) return null;
      let next = goal;
      while (previous[next] !== start && previous[next] !== -1) next = previous[next];
      const x = (next % COLS) * TILE + TILE / 2, y = Math.floor(next / COLS) * TILE + TILE / 2;
      const centerX = sc * TILE + TILE / 2, centerY = sr * TILE + TILE / 2;
      if (Math.abs(x - centerX) > 1 && Math.abs(tank.y - centerY) > 1) return { x: tank.x, y: centerY };
      if (Math.abs(y - centerY) > 1 && Math.abs(tank.x - centerX) > 1) return { x: centerX, y: tank.y };
      return { x, y };
    }

    moveTank(tank, dx, dy) {
      if (!dx && !dy) return false;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const steps = Math.ceil(distance / 3);
      let moved = false;
      for (let step = 0; step < steps; step++) {
        const x = tank.x + dx / steps, y = tank.y + dy / steps;
        const test = { x, y, w: tank.w, h: tank.h };
        if (this.tankBlocked(test, tank)) break;
        tank.x = x; tank.y = y; moved = true;
      }
      return moved;
    }

    tankBlocked(box, self) {
      if (box.x - box.w / 2 < 1 || box.y - box.h / 2 < 1 || box.x + box.w / 2 > WIDTH - 1 || box.y + box.h / 2 > HEIGHT - 1) return true;
      const left = Math.floor((box.x - box.w / 2) / TILE), right = Math.floor((box.x + box.w / 2) / TILE);
      const top = Math.floor((box.y - box.h / 2) / TILE), bottom = Math.floor((box.y + box.h / 2) / TILE);
      for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) {
        const kind = this.map[r] && this.map[r][c];
        if (kind === 1 || kind === 2 || kind === 3) return true;
      }
      if (this.base && overlap(box, this.base, 1)) return true;
      if (this.player && this.player !== self && this.player.alive && overlap(box, this.player, 1)) return true;
      return this.enemies.some(enemy => enemy !== self && overlap(box, enemy, 1));
    }

    shoot(tank, side) {
      if (tank.cooldown > 0 || !tank.alive) return;
      const [dx, dy] = DIRS[tank.dir];
      tank.cooldown = side === 'player' ? (tank.rapid > 0 ? 0.15 : 0.34) : random(0.85, 1.6) / (1 + (this.wave - 1) * 0.1);
      this.bullets.push({ x: tank.x + dx * 18, y: tank.y + dy * 18, w: 5, h: 5, dx, dy, speed: side === 'player' ? 390 : 230 + this.wave * 16, side, alive: true });
      this.spark(tank.x + dx * 19, tank.y + dy * 19, side === 'player' ? '#dcffac' : '#ffc485', 4, 45);
      if (side === 'player') this.sound('shoot');
    }

    updateBullets(dt) {
      for (const bullet of this.bullets) {
        if (!bullet.alive) continue;
        const steps = Math.max(1, Math.ceil(bullet.speed * dt / 5));
        for (let i = 0; i < steps && bullet.alive; i++) {
          bullet.x += bullet.dx * bullet.speed * dt / steps;
          bullet.y += bullet.dy * bullet.speed * dt / steps;
          if (bullet.x < 0 || bullet.y < 0 || bullet.x > WIDTH || bullet.y > HEIGHT) { bullet.alive = false; break; }
          const c = Math.floor(bullet.x / TILE), r = Math.floor(bullet.y / TILE), kind = this.map[r] && this.map[r][c];
          if (kind === 1 || kind === 2) {
            bullet.alive = false;
            this.spark(bullet.x, bullet.y, kind === 1 ? '#b38c5b' : '#b5d4ca', 7, 70);
            if (kind === 1) this.map[r][c] = 0;
            break;
          }
          if (overlap(bullet, this.base)) {
            bullet.alive = false;
            // The defended command post is immune to friendly fire.
            if (bullet.side === 'enemy') {
              this.base.alive = false;
              this.explode(this.base.x, this.base.y, '#e5ca78', 38);
              this.finish(false);
              return;
            }
          }
          if (bullet.side === 'player') {
            for (const enemy of this.enemies) {
              if (!enemy.alive || !overlap(bullet, enemy)) continue;
              bullet.alive = false;
              enemy.hp--;
              if (enemy.hp <= 0) this.destroyEnemy(enemy);
              else { enemy.hitFlash = 0.13; this.spark(enemy.x, enemy.y, '#ffe7b0', 8, 65); this.sound('hit'); }
              break;
            }
          } else if (this.player.alive && overlap(bullet, this.player)) {
            bullet.alive = false;
            if (this.player.shield <= 0) this.destroyPlayer();
            else this.spark(bullet.x, bullet.y, '#aefada', 7, 70);
          }
        }
      }
      for (let i = 0; i < this.bullets.length; i++) {
        const a = this.bullets[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < this.bullets.length; j++) {
          const b = this.bullets[j];
          if (!b.alive || a.side === b.side || !overlap({ ...a, w: 11, h: 11 }, b)) continue;
          a.alive = b.alive = false;
          this.spark(a.x, a.y, '#ede0a5', 4, 45);
          break;
        }
      }
      this.bullets = this.bullets.filter(b => b.alive);
      this.enemies = this.enemies.filter(e => e.alive);
    }

    destroyEnemy(enemy) {
      enemy.alive = false;
      this.kills++;
      const points = enemy.armored ? 200 : 100;
      this.score += points;
      this.updateHighScore();
      this.explode(enemy.x, enemy.y, '#efa36a', 22);
      this.sound('explosion');
      this.particles.push({ x: enemy.x, y: enemy.y - 10, vx: 0, vy: -25, life: 0.9, maxLife: 0.9, text: '+' + points, color: '#dbffb4', size: 12 });
      if (this.kills % 4 === 0) {
        const kind = ['shield', 'rapid', 'repair'][Math.floor(Math.random() * 3)];
        // Put rewards near the player so they are useful during the battle.
        let x = enemy.x, y = enemy.y;
        if (this.player.alive) {
          const candidates = [[this.player.x + 45, this.player.y], [this.player.x - 45, this.player.y], [this.player.x, this.player.y - 45]];
          const free = candidates.find(([px, py]) => !this.tankBlocked({ x: px, y: py, w: 20, h: 20 }, this.player));
          if (free) [x, y] = free;
        }
        this.pickups.push({ x, y, w: 24, h: 24, kind, life: 15 });
        this.onEvent('补给抵达：' + ({ shield: '护盾', rapid: '速射', repair: '维修' }[kind]) + '，靠近即可拾取。');
      }
    }

    destroyPlayer() {
      this.player.alive = false;
      this.lives--;
      this.explode(this.player.x, this.player.y, '#b6e886', 30);
      this.sound('explosion');
      this.flash = 0.27;
      this.clearInput();
      if (this.lives <= 0) { this.finish(false); return; }
      this.respawnClock = 1.3;
      this.onEvent('坦克被击毁。剩余 ' + this.lives + ' 次部署。');
    }

    updatePickups(dt) {
      for (const pickup of this.pickups) {
        pickup.life -= dt;
        if (!this.player.alive || !overlap(this.player, pickup)) continue;
        pickup.life = 0;
        if (pickup.kind === 'shield') this.player.shield = 9;
        if (pickup.kind === 'rapid') this.player.rapid = 12;
        if (pickup.kind === 'repair') {
          this.lives = Math.min(3, this.lives + 1);
          // Never build walls through an existing tank.
          const oldMap = this.map.map(row => row.slice());
          this.restoreBaseWalls();
          for (const tank of [this.player, ...this.enemies]) {
            if (!tank.alive) continue;
            const l = Math.floor((tank.x - tank.w / 2) / TILE), r = Math.floor((tank.x + tank.w / 2) / TILE);
            const t = Math.floor((tank.y - tank.h / 2) / TILE), b = Math.floor((tank.y + tank.h / 2) / TILE);
            for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) if (this.map[y] && oldMap[y] && oldMap[y][x] === 0) this.map[y][x] = 0;
          }
        }
        this.onEvent(({ shield: '能量护盾已启动 · 9 秒', rapid: '速射模式已启动 · 12 秒', repair: '维修完成，基地围墙已修复。' })[pickup.kind]);
        this.spark(pickup.x, pickup.y, '#c4ff8a', 16, 100);
        this.sound('pickup');
      }
      this.pickups = this.pickups.filter(p => p.life > 0);
    }

    updateWaves(dt) {
      if (this.spawned < this.waveTotal) {
        this.spawnClock -= dt;
        if (this.spawnClock <= 0 && this.enemies.length < 4 + (this.wave === 3 ? 1 : 0)) {
          if (this.spawnEnemy()) this.spawnClock = random(1.8, 2.7) / (1 + (this.wave - 1) * 0.13);
          else this.spawnClock = 0.35;
        }
      } else if (!this.enemies.length) {
        if (!this.waveClock) {
          if (this.wave >= 3) { this.finish(true); return; }
          this.waveClock = 3;
          this.showBanner('区域肃清 · 下一波即将抵达', 2.8);
          this.onEvent('第 ' + this.wave + ' 波已清除。准备迎敌。');
        }
        this.waveClock -= dt;
        if (this.waveClock <= 0) {
          this.wave++;
          this.waveTotal = 6 + this.wave * 2;
          this.spawned = 0;
          this.spawnClock = 0.7;
          this.waveClock = 0;
          this.player.shield = Math.max(this.player.shield, 3);
          this.showBanner('第 0' + this.wave + ' 波 · ' + (this.wave === 3 ? '最终防线' : '敌军增援'), 2.8);
          this.onEvent('第 ' + this.wave + ' 波敌军进入战区。');
        }
      }
    }

    spawnEnemy() {
      const lanes = [45, 345, 675].sort(() => Math.random() - 0.5);
      for (const x of lanes) {
        const box = { x, y: 24, w: 23, h: 23 };
        if (this.tankBlocked(box, null)) continue;
        const armored = this.wave >= 2 && this.spawned % 4 === 3;
        this.enemies.push({ ...box, alive: true, dir: 'down', hp: armored ? 2 : 1, armored, speed: armored ? 58 + this.wave * 4 : 66 + this.wave * 8, cooldown: 1.2, planClock: 0, waypoint: null, track: 0, hitFlash: 0 });
        this.spawned++;
        this.spark(x, 24, '#e28d6a', 11, 60);
        return true;
      }
      return false;
    }

    updateParticles(dt) {
      for (const particle of this.particles) {
        particle.life -= dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        if (!particle.text) { particle.vx *= 1 - dt * 2; particle.vy *= 1 - dt * 2; }
      }
      this.particles = this.particles.filter(p => p.life > 0);
      for (const enemy of this.enemies) enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
    }

    updateHighScore() {
      if (this.score <= this.highScore) return;
      this.highScore = this.score;
      try { localStorage.setItem(STORAGE_KEY, String(this.highScore)); } catch (_) { /* Private browsing may disable storage. */ }
    }

    finish(victory) {
      if (!this.running) return;
      this.running = false;
      this.paused = false;
      this.clearInput();
      if (victory) { this.score += this.lives * 500; this.updateHighScore(); }
      this.onEvent(victory ? '任务完成！三波敌军已全部清除。' : this.base.alive ? '部署耗尽。本次作战结束。' : '指挥部被摧毁。本次作战结束。');
      this.sound(victory ? 'win' : 'lose');
      this.draw();
      this.emitState();
      this.onEnd({ victory, score: this.score, kills: this.kills, wave: this.wave });
    }

    showBanner(text, duration) { this.banner = text; this.bannerClock = duration; }

    spark(x, y, color, count, speed) {
      for (let i = 0; i < count; i++) {
        const angle = random(0, Math.PI * 2), velocity = random(speed * 0.25, speed), life = random(0.18, 0.5);
        this.particles.push({ x, y, vx: Math.cos(angle) * velocity, vy: Math.sin(angle) * velocity, color, life, maxLife: life, size: random(1.5, 4) });
      }
    }

    explode(x, y, color, count) {
      this.shake = Math.min(7, this.shake + 3.5);
      this.spark(x, y, color, count, 145);
      this.spark(x, y, '#ffe5ad', Math.floor(count / 3), 85);
      this.particles.push({ x, y, vx: 0, vy: 0, color, life: 0.32, maxLife: 0.32, ring: true, size: 4 });
    }

    draw() {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = '#111b16';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      if (this.shake > 0 && !this.paused) ctx.translate(random(-this.shake, this.shake), random(-this.shake, this.shake));
      this.drawGround(ctx);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this.map[r][c] !== 4) this.drawTile(ctx, c, r, this.map[r][c]);
      this.drawBase(ctx);
      this.drawSpawnMarkers(ctx);
      for (const pickup of this.pickups) this.drawPickup(ctx, pickup);
      for (const enemy of this.enemies) this.drawTank(ctx, enemy, false);
      if (this.player.alive) this.drawTank(ctx, this.player, true);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this.map[r][c] === 4) this.drawTile(ctx, c, r, 4);
      this.drawBullets(ctx);
      this.drawParticles(ctx);
      if (this.flash > 0) { ctx.fillStyle = 'rgba(221, 97, 66,' + this.flash + ')'; ctx.fillRect(0, 0, WIDTH, HEIGHT); }
      const vignette = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, HEIGHT / 4, WIDTH / 2, HEIGHT / 2, HEIGHT * 0.85);
      vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,8,4,0.4)');
      ctx.fillStyle = vignette; ctx.fillRect(0, 0, WIDTH, HEIGHT);
      if (this.bannerClock > 0 && this.running && !this.paused) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, this.bannerClock);
        ctx.fillStyle = 'rgba(12,22,16,0.9)'; ctx.fillRect(170, 273, 380, 46);
        ctx.strokeStyle = '#859b5a'; ctx.strokeRect(170.5, 273.5, 379, 45);
        ctx.textAlign = 'center'; ctx.font = 'bold 17px "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#d9f3b0'; ctx.fillText(this.banner, WIDTH / 2, 302);
        ctx.restore();
      }
      ctx.restore();
    }

    drawGround(ctx) {
      ctx.strokeStyle = 'rgba(128,159,111,0.075)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= WIDTH; x += TILE) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, HEIGHT); }
      for (let y = 0; y <= HEIGHT; y += TILE) { ctx.moveTo(0, y + 0.5); ctx.lineTo(WIDTH, y + 0.5); }
      ctx.stroke();
      // Fixed, deterministic speckle texture; it does not flicker between frames.
      ctx.fillStyle = 'rgba(174,191,139,0.12)';
      for (let i = 0; i < 190; i++) { const x = (i * 173 + 31) % WIDTH, y = (i * 97 + 17) % HEIGHT; ctx.fillRect(x, y, i % 4 === 0 ? 2 : 1, 1); }
      ctx.strokeStyle = 'rgba(160,175,129,0.12)';
      ctx.setLineDash([4, 11]); ctx.strokeRect(10.5, 10.5, WIDTH - 21, HEIGHT - 21); ctx.setLineDash([]);
    }

    drawTile(ctx, c, r, kind) {
      const x = c * TILE, y = r * TILE;
      if (kind === 1) {
        ctx.fillStyle = '#302d22'; ctx.fillRect(x, y, TILE, TILE);
        for (let row = 0; row < 3; row++) {
          const offset = row % 2 ? -7 : 0;
          for (let col = 0; col < 3; col++) {
            const bx = x + col * 15 + offset;
            const l = Math.max(x + 1, bx + 1), right = Math.min(x + TILE - 1, bx + 14);
            if (right <= l) continue;
            ctx.fillStyle = (c + r + row) % 3 === 0 ? '#8d7350' : '#7d6747'; ctx.fillRect(l, y + row * 10 + 1, right - l, 8);
            ctx.fillStyle = '#a18a60'; ctx.fillRect(l, y + row * 10 + 1, right - l, 1);
            ctx.fillStyle = '#5e5038'; ctx.fillRect(l, y + row * 10 + 8, right - l, 1);
          }
        }
      } else if (kind === 2) {
        ctx.fillStyle = '#141e1c'; ctx.fillRect(x, y, TILE, TILE);
        ctx.fillStyle = '#667770'; ctx.fillRect(x + 1, y + 1, 28, 28);
        ctx.fillStyle = '#8c9b8d'; ctx.fillRect(x + 2, y + 2, 26, 2); ctx.fillRect(x + 2, y + 2, 2, 26);
        ctx.fillStyle = '#44574f'; ctx.fillRect(x + 4, y + 4, 22, 22);
        ctx.strokeStyle = '#73857a'; ctx.lineWidth = 1; ctx.strokeRect(x + 7.5, y + 7.5, 15, 15);
        ctx.fillStyle = '#adba9e'; for (const [dx, dy] of [[4, 4], [24, 4], [4, 24], [24, 24]]) ctx.fillRect(x + dx, y + dy, 2, 2);
      } else if (kind === 3) {
        ctx.fillStyle = '#163e43'; ctx.fillRect(x, y, TILE, TILE);
        ctx.strokeStyle = '#286069'; ctx.lineWidth = 2;
        const offset = Math.sin(this.elapsed * 2 + c) * 3;
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x + 3 + offset, y + 6 + i * 9); ctx.lineTo(x + 13 + offset, y + 6 + i * 9); ctx.moveTo(x + 19 - offset, y + 9 + i * 9); ctx.lineTo(x + 26 - offset, y + 9 + i * 9); ctx.stroke(); }
      } else if (kind === 4) {
        ctx.fillStyle = 'rgba(34,64,39,.9)'; ctx.fillRect(x + 1, y + 1, 28, 28);
        for (let i = 0; i < 9; i++) {
          const gx = x + (i * 13 + c * 5) % 25 + 2, gy = y + (i * 7 + r * 3) % 24 + 3;
          ctx.fillStyle = i % 2 ? '#3b5934' : '#536c3c'; ctx.fillRect(gx, gy, 4, 7); ctx.fillRect(gx - 2, gy + 2, 8, 2);
        }
      }
    }

    drawBase(ctx) {
      const base = this.base;
      ctx.save(); ctx.translate(base.x, base.y);
      ctx.strokeStyle = '#526548'; ctx.setLineDash([3, 3]); ctx.strokeRect(-24.5, -24.5, 49, 49); ctx.setLineDash([]);
      if (!base.alive) {
        ctx.fillStyle = '#685c3e'; ctx.fillRect(-12, -8, 24, 17); ctx.fillStyle = '#2c2d24'; ctx.fillRect(-8, -4, 9, 9); ctx.fillRect(3, 3, 8, 8);
      } else {
        ctx.fillStyle = '#384333'; ctx.fillRect(-13, -14, 26, 28);
        ctx.strokeStyle = '#a2ad75'; ctx.strokeRect(-12.5, -13.5, 25, 27);
        ctx.fillStyle = '#c9d994'; ctx.fillRect(-9, -8, 18, 5); ctx.fillRect(-6, -3, 12, 8); ctx.fillRect(-3, 5, 6, 5);
        ctx.fillStyle = '#25322a'; ctx.fillRect(-1, -7, 2, 8);
        ctx.fillStyle = '#c1ef88'; ctx.fillRect(7, 9, 3, 2);
      }
      ctx.restore();
    }

    drawSpawnMarkers(ctx) {
      ctx.fillStyle = 'rgba(197,119,87,.38)';
      for (const x of [45, 345, 675]) {
        ctx.beginPath(); ctx.moveTo(x - 5, 7); ctx.lineTo(x + 5, 7); ctx.lineTo(x, 12); ctx.fill();
      }
      ctx.fillStyle = '#718165'; ctx.font = '8px monospace'; ctx.textAlign = 'left'; ctx.fillText('HQ', this.base.x - 6, 598);
    }

    drawTank(ctx, tank, player) {
      ctx.save(); ctx.translate(Math.round(tank.x), Math.round(tank.y));
      if (player && tank.shield > 0) {
        ctx.strokeStyle = 'rgba(172,244,159,' + (0.45 + Math.sin(this.elapsed * 9) * 0.18) + ')';
        ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(151,232,130,0.04)'; ctx.fill();
      }
      ctx.rotate(ANGLES[tank.dir]);
      ctx.fillStyle = '#050c08'; ctx.fillRect(-13, -10, 27, 27);
      const color = player ? '#a7c974' : tank.armored ? '#c4b38a' : '#ce815d';
      const dark = player ? '#526c3d' : tank.armored ? '#736f58' : '#7d4535';
      ctx.fillStyle = '#202a21'; ctx.fillRect(-12, -13, 7, 27); ctx.fillRect(5, -13, 7, 27);
      ctx.fillStyle = dark; ctx.fillRect(-11, -13, 5, 26); ctx.fillRect(6, -13, 5, 26);
      ctx.fillStyle = '#142016';
      const phase = Math.floor(tank.track) % 5;
      for (let y = -12 + phase; y < 13; y += 5) { ctx.fillRect(-11, y, 5, 2); ctx.fillRect(6, y, 5, 2); }
      ctx.fillStyle = color; ctx.fillRect(-7, -11, 14, 22);
      ctx.fillStyle = dark; ctx.fillRect(-6, 8, 12, 3); ctx.fillRect(-6, -7, 12, 3);
      ctx.fillStyle = player ? '#d4e7aa' : '#e9bd90'; ctx.fillRect(-7, -11, 2, 19);
      ctx.fillStyle = dark; ctx.fillRect(-7, -4, 14, 12);
      ctx.fillStyle = color; ctx.fillRect(-6, -5, 12, 11);
      ctx.fillStyle = player ? '#789a53' : '#a56e50'; ctx.fillRect(-3, -3, 6, 6);
      ctx.fillStyle = dark; ctx.fillRect(-3, -19, 6, 16);
      ctx.fillStyle = color; ctx.fillRect(-2, -20, 4, 16);
      ctx.fillStyle = '#f0eac0'; ctx.fillRect(-2, -20, 2, 4);
      ctx.fillStyle = '#233023'; ctx.fillRect(-4, 6, 3, 2); ctx.fillRect(2, 6, 3, 2);
      if (tank.armored && tank.hp > 1) { ctx.strokeStyle = '#fff0bd'; ctx.strokeRect(-5.5, -4.5, 11, 9); }
      if (tank.hitFlash > 0) { ctx.fillStyle = 'rgba(255,255,220,.65)'; ctx.fillRect(-10, -12, 20, 24); }
      ctx.restore();
    }

    drawPickup(ctx, pickup) {
      if (pickup.life < 3 && Math.sin(this.elapsed * 15) < 0) return;
      const x = Math.round(pickup.x), y = Math.round(pickup.y);
      const color = pickup.kind === 'repair' ? '#ebce83' : pickup.kind === 'shield' ? '#8bc7bc' : '#c3ec86';
      ctx.fillStyle = '#15261b'; ctx.fillRect(x - 13, y - 13, 26, 26);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(x - 12.5, y - 12.5, 25, 25);
      ctx.fillStyle = color;
      if (pickup.kind === 'repair') { ctx.fillRect(x - 2, y - 7, 4, 14); ctx.fillRect(x - 7, y - 2, 14, 4); }
      else if (pickup.kind === 'rapid') { ctx.beginPath(); ctx.moveTo(x + 2, y - 8); ctx.lineTo(x - 5, y + 1); ctx.lineTo(x, y + 1); ctx.lineTo(x - 2, y + 8); ctx.lineTo(x + 6, y - 2); ctx.lineTo(x + 1, y - 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(x - 7, y - 6); ctx.lineTo(x, y - 9); ctx.lineTo(x + 7, y - 6); ctx.lineTo(x + 6, y + 3); ctx.lineTo(x, y + 9); ctx.lineTo(x - 6, y + 3); ctx.closePath(); ctx.stroke(); }
    }

    drawBullets(ctx) {
      for (const bullet of this.bullets) {
        const x = Math.round(bullet.x), y = Math.round(bullet.y);
        ctx.fillStyle = bullet.side === 'player' ? 'rgba(196,244,131,0.18)' : 'rgba(244,167,104,0.18)';
        ctx.fillRect(x - 4 - bullet.dx * 7, y - 4 - bullet.dy * 7, 8 + Math.abs(bullet.dx) * 8, 8 + Math.abs(bullet.dy) * 8);
        ctx.fillStyle = bullet.side === 'player' ? '#e2ffb3' : '#ffd194'; ctx.fillRect(x - 2, y - 2, 4, 4);
      }
    }

    drawParticles(ctx) {
      for (const particle of this.particles) {
        ctx.save();
        ctx.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
        ctx.fillStyle = particle.color;
        if (particle.text) {
          ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center'; ctx.fillText(particle.text, particle.x, particle.y);
        } else if (particle.ring) {
          ctx.strokeStyle = particle.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(particle.x, particle.y, 5 + (1 - particle.life / particle.maxLife) * 33, 0, Math.PI * 2); ctx.stroke();
        } else ctx.fillRect(Math.round(particle.x), Math.round(particle.y), particle.size, particle.size);
        ctx.restore();
      }
    }

    ensureAudio() {
      if (this.muted) return;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!this.audio) this.audio = new AudioContextClass();
        if (this.audio.state === 'suspended') this.audio.resume().catch(() => {});
      } catch (_) { /* The game is fully usable without audio. */ }
    }

    sound(kind) {
      if (this.muted || !this.audio || this.audio.state !== 'running') return;
      try {
        const config = {
          shoot: [160, 55, 0.07, 'square', 0.028], hit: [170, 70, 0.09, 'triangle', 0.06],
          explosion: [85, 22, 0.24, 'sawtooth', 0.055], pickup: [460, 920, 0.2, 'square', 0.04],
          win: [440, 880, 0.7, 'triangle', 0.07], lose: [180, 35, 0.8, 'sawtooth', 0.05]
        }[kind];
        const oscillator = this.audio.createOscillator(), gain = this.audio.createGain(), now = this.audio.currentTime;
        oscillator.type = config[3]; oscillator.frequency.setValueAtTime(config[0], now); oscillator.frequency.exponentialRampToValueAtTime(config[1], now + config[2]);
        gain.gain.setValueAtTime(config[4], now); gain.gain.exponentialRampToValueAtTime(0.001, now + config[2]);
        oscillator.connect(gain); gain.connect(this.audio.destination); oscillator.start(now); oscillator.stop(now + config[2]);
      } catch (_) { /* A missing sound must never interrupt gameplay. */ }
    }

    destroy() {
      this.running = false;
      cancelAnimationFrame(this.frame);
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      if (this.audio) this.audio.close().catch(() => {});
    }
  }

  window.TankGame = TankGame;
})();
