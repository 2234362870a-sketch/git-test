/* Frontline 1985 — interface and accessible input bindings. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('game-canvas');
  const overlay = $('game-overlay');
  const dialog = $('help-dialog');
  let started = false;
  let ended = false;
  let latest = { running: false, paused: false, muted: false, lives: 3, wave: 1, enemiesRemaining: 8 };
  let previousEnemies = -1;
  let previousLives = -1;
  const pad = (n, length = 2) => String(Math.max(0, Number(n) || 0)).padStart(length, '0');
  const tankIcon = '<svg aria-hidden="true"><use href="#i-tank"/></svg>';

  function showOverlay(mode, result) {
    overlay.hidden = false;
    $('overlay-eyebrow').textContent = mode === 'paused' ? 'TAKE A BREATH. HOLD THE LINE.' : result.victory ? 'MISSION ACCOMPLISHED' : 'THE BATTLE IS OVER. NOT THE WAR.';
    $('overlay-title').textContent = mode === 'paused' ? '战场已暂停。' : result.victory ? '防线，守住了。' : '下一次，守得更久。';
    $('overlay-description').textContent = mode === 'paused' ? '整备片刻，你的基地正在等待。' : `本局得分 ${pad(result.score, 5)} · 击毁 ${result.kills} 辆敌军坦克`;
    $('start-label').textContent = mode === 'paused' ? '继续作战' : '再次出击';
    $('overlay-hint').textContent = mode === 'paused' ? '按 P 或 ENTER 继续' : '按 ENTER 重返前线';
  }

  function updateState(state) {
    const wasPaused = latest.paused;
    latest = { ...latest, ...state };
    $('score').textContent = pad(latest.score, 5);
    $('high-score').textContent = pad(latest.highScore, 5);
    $('wave').textContent = pad(latest.wave);
    $('enemies').textContent = pad(latest.enemiesRemaining);
    $('kills').textContent = pad(latest.kills);
    if (latest.lives !== previousLives) {
      $('lives').innerHTML = Array.from({length:3}, (_, i) => `<svg class="${i >= latest.lives ? 'lost' : ''}" aria-hidden="true"><use href="#i-tank"/></svg>`).join('');
      $('lives').setAttribute('aria-label', `${latest.lives} 条生命`);
      previousLives = latest.lives;
    }
    if (latest.enemiesRemaining !== previousEnemies) {
      $('enemy-grid').innerHTML = Array.from({length:Math.max(8, latest.enemiesRemaining)}, (_, i) => tankIcon.replace('<svg ', `<svg class="${i >= latest.enemiesRemaining ? 'spent' : ''}" `)).join('');
      previousEnemies = latest.enemiesRemaining;
    }
    [...$('wave-track').children].forEach((el, i) => el.classList.toggle('active', i < latest.wave));
    $('sound-button').classList.toggle('is-muted', latest.muted);
    $('sound-button').setAttribute('aria-label', latest.muted ? '开启音效' : '关闭音效');
    $('sound-button').setAttribute('aria-pressed', String(latest.muted));
    $('pause-button').disabled = !started || ended;
    $('restart-button').disabled = !started;
    $('pause-button').setAttribute('aria-label', latest.paused ? '继续游戏' : '暂停游戏');
    $('arena-status').textContent = ended ? '战役结束' : latest.paused ? '战场暂停' : started ? '作战进行中' : '等待部署';
    $('arena-dot').style.background = latest.paused || ended ? '#9b9e77' : '';
    $('toolbar-label').textContent = ended ? '战役完成' : latest.paused ? '暂停中' : '单人战役';
    if (started && !ended && latest.paused && !wasPaused) showOverlay('paused');
    if (started && !ended && !latest.paused && wasPaused) overlay.hidden = true;
    const powerup = latest.powerup;
    $('powerup-status').hidden = !powerup || !started || ended || powerup === '标准火力';
    $('powerup-status').textContent = typeof powerup === 'string' ? powerup : powerup?.label || '';
  }

  const game = new window.TankGame(canvas, {
    onState: updateState,
    onEvent(message) {
      const item = document.createElement('li');
      const prefix = document.createElement('span');
      prefix.textContent = 'HQ';
      item.append(prefix, document.createTextNode(String(message)));
      $('event-log').prepend(item);
      while ($('event-log').children.length > 3) $('event-log').lastChild.remove();
    },
    onEnd(result) {
      ended = true;
      releaseInputs();
      showOverlay('ended', result);
      updateState({running:false, paused:false});
      $('start-button').focus({preventScroll:true});
    }
  });

  function begin() {
    if (dialog.open) return;
    if (latest.paused && !ended) {
      game.togglePause();
      updateState({paused:false});
    } else {
      const isRestart = started;
      started = true;
      ended = false;
      $('event-log').replaceChildren();
      releaseInputs();
      if (isRestart) game.restart(); else game.start();
      updateState({paused:false, running:true});
    }
    overlay.hidden = true;
    canvas.focus({preventScroll:true});
  }
  function pause() {
    if (!started || ended || dialog.open) return;
    releaseInputs();
    game.togglePause();
  }
  function releaseInputs() {
    for (const action of ['up','down','left','right','fire']) game.setInput(action, false);
    document.querySelectorAll('[data-action]').forEach(button => button.classList.remove('pressed'));
    heldCodes.clear();
  }
  const heldCodes = new Set();
  const keyMap = {KeyW:'up',ArrowUp:'up',KeyS:'down',ArrowDown:'down',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',Space:'fire'};
  $('start-button').addEventListener('click', begin);
  $('pause-button').addEventListener('click', pause);
  $('restart-button').addEventListener('click', () => { ended = true; begin(); });
  $('sound-button').addEventListener('click', (event) => {
    updateState({muted:game.toggleMute()});
    if (event.detail && started && !ended) canvas.focus({preventScroll:true});
  });
  $('fullscreen-button').addEventListener('click', async (event) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('battlefield').parentElement.requestFullscreen) await $('battlefield').parentElement.requestFullscreen();
    } catch { /* Embedded browsers may not grant fullscreen. Keep the game playable. */ }
    if (event.detail && started && !ended) canvas.focus({preventScroll:true});
  });
  if (!document.fullscreenEnabled) $('fullscreen-button').hidden = true;
  window.addEventListener('keydown', (event) => {
    if (dialog.open || event.ctrlKey || event.altKey || event.metaKey) return;
    const action = keyMap[event.code];
    if (action) {
      if (!started || ended || latest.paused) return;
      // Preserve native button activation when navigating the interface with a keyboard.
      if (event.code === 'Space' && event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      heldCodes.add(event.code);
      game.setInput(action, true);
    } else if (!event.repeat && event.code === 'KeyP') { event.preventDefault(); pause(); }
    else if (!event.repeat && event.code === 'KeyM') updateState({muted:game.toggleMute()});
    else if (!event.repeat && event.code === 'Enter' && !overlay.hidden && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); begin(); }
  });
  window.addEventListener('keyup', (event) => {
    const action = keyMap[event.code];
    if (!action) return;
    heldCodes.delete(event.code);
    game.setInput(action, Object.keys(keyMap).some(code => keyMap[code] === action && heldCodes.has(code)));
  });
  function autoPause() {
    releaseInputs();
    if (started && !ended && !latest.paused) game.togglePause();
  }
  window.addEventListener('blur', autoPause);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
  document.querySelectorAll('[data-action]').forEach(button => {
    const action = button.dataset.action;
    const release = (event) => {
      event.preventDefault();
      game.setInput(action, false);
      button.classList.remove('pressed');
    };
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      if (!started || ended || latest.paused || dialog.open) return;
      button.setPointerCapture(event.pointerId);
      game.setInput(action, true);
      button.classList.add('pressed');
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    button.addEventListener('contextmenu', event => event.preventDefault());
  });
  $('help-button').addEventListener('click', () => { autoPause(); dialog.showModal(); });
  document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r=dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
  updateState(latest);
  updateState({highScore:game.highScore});
})();
