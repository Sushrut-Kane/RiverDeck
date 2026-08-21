/*
 * online.js — the lobby and the online table.
 *
 * Talks to server.js over a tiny JSON API and long-polling. It reuses the exact
 * same table DOM as the offline game (opponents / community / human / controls /
 * log), so playing online looks and feels the same — you just see live friends
 * (and AI fillers) instead of a local single-player game.
 *
 * The offline game lives in game.js; this file only takes over when you choose
 * "play online". Human button clicks are routed here via game.js's dispatch
 * (window.Online.active), so both modes share one set of controls.
 */
(function () {
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const Online = { active: false, code: null, token: null, version: 0, view: null, polling: false };
  window.Online = Online;
  let shareLine = null; // cached once per page load

  const ERRORS = {
    no_room: 'Room not found.',
    room_full: 'That room is already full.',
    table_full: 'The table is full — no seat free.',
    need_two_players: 'Need at least two players (or turn on AI fill).',
    no_players: 'No players have joined yet.',
    already_started: 'That game has already started.',
    bad_code: 'Please enter a valid game code.'
  };
  const friendly = code => ERRORS[code] || 'Something went wrong. Try again.';

  function post(path, body) {
    return fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => r.json());
  }

  // ---- Overlay / panels ----------------------------------------------------

  function showOverlay() { $('lobby').classList.remove('hidden'); }
  function hideOverlay() { $('lobby').classList.add('hidden'); }
  function showPanel(id) {
    for (const p of ['lobby-choose', 'lobby-online', 'lobby-room']) {
      $(p).hidden = (p !== id);
    }
  }

  function randomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  function initLobby() {
    $('lobby-solo').addEventListener('click', () => { hideOverlay(); window.startSolo(); });
    $('lobby-online-btn').addEventListener('click', () => {
      showPanel('lobby-online');
      if (!$('lobby-code').value) $('lobby-code').value = randomCode();
      $('lobby-name').focus();
    });
    $('lobby-back').addEventListener('click', () => showPanel('lobby-choose'));
    $('lobby-random').addEventListener('click', () => { $('lobby-code').value = randomCode(); });
    $('lobby-join').addEventListener('click', joinFromForm);
    $('lobby-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinFromForm(); });
    $('room-start').addEventListener('click', startFromRoom);
    $('room-leave').addEventListener('click', leave);
  }

  // ---- Join / start --------------------------------------------------------

  async function joinFromForm() {
    const code = ($('lobby-code').value || '').trim().toUpperCase();
    const name = ($('lobby-name').value || '').trim();
    const fillAI = $('lobby-fill').checked;
    $('lobby-error').textContent = '';
    if (!code) { $('lobby-error').textContent = 'Enter a game code to create or join a table.'; return; }
    try {
      const res = await post('join', { code, name, fillAI });
      if (res.error) throw new Error(res.error);
      Online.active = true;
      Online.code = code;
      Online.token = res.token;
      Online.view = res.view;
      Online.version = res.view.version;
      applyView(res.view);
      startPolling();
    } catch (e) {
      $('lobby-error').textContent = friendly(e.message);
    }
  }

  async function startFromRoom() {
    const fillAI = $('room-fill').checked;
    $('room-hint').textContent = 'Starting…';
    try {
      const res = await post('start', { code: Online.code, token: Online.token, fillAI });
      if (res.error) throw new Error(res.error);
      if (res.view) applyView(res.view);
    } catch (e) {
      $('room-hint').textContent = friendly(e.message);
    }
  }

  function leave() {
    Online.active = false;
    Online.code = null;
    Online.token = null;
    Online.version = 0;
    showPanel('lobby-choose');
    showOverlay();
  }

  // ---- Polling -------------------------------------------------------------

  async function startPolling() {
    if (Online.polling) return;
    Online.polling = true;
    while (Online.active) {
      try {
        const r = await fetch(`/api/state?code=${encodeURIComponent(Online.code)}&token=${encodeURIComponent(Online.token)}&v=${Online.version}`);
        const data = await r.json();
        if (!Online.active) break;
        if (data.error) { await sleep(1200); continue; }
        Online.version = data.version;
        Online.view = data.view;
        applyView(data.view);
      } catch (e) {
        await sleep(1200);
      }
    }
    Online.polling = false;
  }

  // ---- Actions (called by game.js dispatch) --------------------------------

  Online.act = async function (intent) {
    hideControls();
    try {
      const res = await post('action', { code: Online.code, token: Online.token, move: intent.action, amount: intent.amount });
      if (res.view) applyView(res.view);
    } catch (e) { /* the next poll will resync */ }
  };
  Online.next = async function () {
    try {
      const res = await post('next', { code: Online.code, token: Online.token });
      if (res.view) applyView(res.view);
    } catch (e) { /* ignore */ }
  };

  // ---- Rendering -----------------------------------------------------------

  function playTransitions(view) {
    if (!window.FX) return;
    const prev = Online._prev;
    if (prev && prev.handNumber != null) {
      if (view.handNumber !== prev.handNumber && view.phase === 'hand') FX.sound('deal');
      for (const p of view.players) {
        const pp = prev.players && prev.players.find(x => x.id === p.id);
        if (pp && p.lastAction && p.lastAction !== pp.lastAction) {
          const w = (p.lastAction.split(' ')[0] || '').toLowerCase();
          if (w === 'fold' || w === 'check' || w === 'call') FX.actionSound(w);
          else if (w === 'raise' || w === 'bet' || w === 'all-in') FX.actionSound('raise');
        }
      }
      if (view.revealAll && !prev.revealAll) FX.sound('win');
      if (view.pot > prev.pot) {
        const potEl = document.getElementById('pot');
        if (potEl) { potEl.classList.remove('bump'); void potEl.offsetWidth; potEl.classList.add('bump'); }
      }
    }
    Online._prev = view;
  }

  function applyView(view) {
    if (view.phase === 'lobby') {
      renderRoom(view);
      Online._prev = null;
      return;
    }
    hideOverlay();
    playTransitions(view);
    renderGame(view);
  }

  // Tell the host the exact address a friend should open to reach this table.
  function updateShare() {
    const el = $('room-share');
    if (!el) return;
    if (shareLine !== null) { el.innerHTML = shareLine; return; }
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      fetch('/api/info').then(r => r.json()).then(info => {
        shareLine = info.lanUrl
          ? `On the same Wi-Fi? Friends open <b>${info.lanUrl}</b> and enter the code.`
          : 'To play with friends elsewhere, put the server online (see README).';
        el.innerHTML = shareLine;
      }).catch(() => {});
    } else {
      shareLine = `Friends open <b>${location.origin}</b> and enter the code.`;
      el.innerHTML = shareLine;
    }
  }

  function renderRoom(view) {
    showOverlay();
    showPanel('lobby-room');
    $('room-code').textContent = view.code;
    updateShare();
    const list = $('room-players');
    list.innerHTML = '';
    const names = (view.lobby && view.lobby.players) || [];
    names.forEach((n, i) => {
      const li = document.createElement('li');
      li.textContent = (i === 0 ? n + ' (host)' : n);
      list.appendChild(li);
    });
    const isHost = view.lobby && view.lobby.isHost;
    $('room-hint').textContent = isHost
      ? 'Share the code, then start when everyone is in. Empty seats become AI.'
      : 'Waiting for the host to start… empty seats will be filled with AI.';
    $('room-start').style.display = isHost ? 'inline-block' : 'none';
    $('room-fill').parentElement.style.display = isHost ? 'flex' : 'none';
  }

  function badges(p) {
    if (p.isDealer) return '<span class="badge dealer">D</span>';
    if (p.isSB) return '<span class="badge">SB</span>';
    if (p.isBB) return '<span class="badge">BB</span>';
    return '';
  }
  function avatar(p) {
    return `<span class="avatar" data-seat="${p.id}">${(p.name || '?').charAt(0)}</span>`;
  }

  function renderGame(view) {
    $('stage-label').textContent = view.stage;
    $('pot').textContent = `Pot: ${view.pot}`;
    $('message').textContent = view.message || '';
    CardsUI.syncBoard($('community'), view.community);

    const you = view.players[view.you];
    renderOpponents(view);
    renderYou(view, you);
    renderStatus(view);
    renderControls(view);
    renderTableButtons(view);
    renderAIDebug(view);
  }

  function renderOpponents(view) {
    const container = $('opponents');
    container.innerHTML = '';
    for (const p of view.players) {
      if (p.id === view.you) continue;
      const box = document.createElement('div');
      box.className = 'player';
      if (p.isActive) box.classList.add('active');
      if (p.folded && !p.out) box.classList.add('folded');
      if (p.out) box.classList.add('out');

      const showFace = !!p.hole;
      const cards = p.out ? '' :
        `<div class="cards">${p.hasCards || showFace
          ? CardsUI.cardHTML(showFace ? p.hole[0] : null, !showFace) + CardsUI.cardHTML(showFace ? p.hole[1] : null, !showFace)
          : ''}</div>`;
      const handInfo = p.handName ? `<div class="hand-name">${p.handName}</div>` : '';

      box.innerHTML =
        `<div class="p-head"><span class="who">${avatar(p)}<span class="p-name">${p.name}</span></span>${badges(p)}</div>` +
        cards +
        `<div class="p-chips">${p.out ? 'OUT' : p.chips + ' chips'}</div>` +
        `<div class="p-bet">${window.FX ? FX.chipHTML(p.bet) : (p.bet > 0 ? 'bet ' + p.bet : '')}</div>` +
        `<div class="p-action">${p.lastAction || ''}</div>` +
        handInfo;
      container.appendChild(box);
    }
  }

  function renderYou(view, you) {
    const box = $('human');
    box.classList.toggle('active', !!(you && you.isActive));
    box.classList.toggle('folded', !!(you && you.folded && !you.out));
    box.classList.toggle('out', !!(you && you.out));

    CardsUI.syncHole($('human-cards'), (you && you.hole) || [], { faceDown: false, handKey: view.handNumber });

    let handText = '';
    if (you && you.hole && you.hole.length === 2 && view.community.length >= 3) {
      handText = 'Your hand: ' + handName(evaluate7([...you.hole, ...view.community]));
    }
    $('human-hand').textContent = handText;

    $('human-info').innerHTML = you
      ? `<span class="who">${avatar(you)}<span class="p-name">${you.name} (you)</span></span>${badges(you)}` +
        `<span class="p-chips">${you.out ? 'OUT' : you.chips + ' chips'}</span>` +
        `<span class="p-bet">${window.FX ? FX.chipHTML(you.bet) : (you.bet > 0 ? 'bet ' + you.bet : '')}</span>` +
        `<span class="p-action">${you.lastAction || ''}</span>`
      : '<span class="p-name">Spectating</span>';
  }

  function renderStatus(view) {
    const el = $('turn-status');
    if (view.awaiting) { el.textContent = 'Your move'; return; }
    const active = view.players.find(p => p.isActive);
    el.textContent = active ? `${active.name} is thinking\u2026` : '';
  }

  function renderControls(view) {
    if (!view.awaiting) { hideControls(); return; }
    const a = view.awaiting;
    $('controls').style.display = 'flex';
    $('human').scrollIntoView({ behavior: 'smooth', block: 'center' });

    const checkCall = $('btn-check-call');
    if (a.canCheck) {
      checkCall.textContent = 'Check';
      checkCall.dataset.mode = 'check';
    } else {
      checkCall.textContent = a.toCall >= a.maxTotal - (view.players[view.you].bet) ? `Call ${a.toCall} (All-In)` : `Call ${a.toCall}`;
      checkCall.dataset.mode = 'call';
    }
    checkCall.disabled = false;

    const raiseWrap = $('raise-area');
    if (a.canRaise) {
      raiseWrap.style.display = 'flex';
      const slider = $('raise-slider');
      const input = $('raise-input');
      slider.min = a.minRaiseTotal; slider.max = a.maxTotal; slider.value = a.minRaiseTotal;
      input.min = a.minRaiseTotal; input.max = a.maxTotal; input.value = a.minRaiseTotal;
      $('btn-raise').disabled = false;
      $('btn-raise').textContent = view.currentBet === 0 ? 'Bet' : 'Raise to';
    } else {
      raiseWrap.style.display = 'none';
    }

    const allIn = $('btn-allin');
    allIn.style.display = a.maxTotal > (view.players[view.you].bet) ? 'inline-block' : 'none';
    allIn.textContent = `All-In (${a.maxTotal})`;
  }

  function hideControls() { $('controls').style.display = 'none'; }

  function renderTableButtons(view) {
    const next = $('btn-next-hand');
    const leaveBtn = $('btn-new-game');
    if (view.phase === 'handover') {
      next.style.display = 'inline-block';
      next.textContent = 'Deal Next Hand';
      leaveBtn.style.display = 'none';
    } else if (view.phase === 'gameover') {
      next.style.display = 'inline-block';
      next.textContent = 'New Game';
      leaveBtn.style.display = 'inline-block';
      leaveBtn.textContent = 'Leave Table';
    } else {
      next.style.display = 'none';
      leaveBtn.style.display = 'none';
    }
  }

  function renderAIDebug(view) {
    const el = $('ai-decision-log');
    if (!el) return;
    el.innerHTML = '';
    for (const note of (view.aiLog || [])) {
      const line = document.createElement('div');
      line.className = 'ai-decision-line';
      line.textContent = note;
      el.appendChild(line);
    }
    renderLog(view);
  }

  function renderLog(view) {
    const el = $('log');
    if (!el) return;
    el.innerHTML = '';
    for (const msg of (view.log || [])) {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = msg;
      el.appendChild(line);
    }
  }

  // Expose the lobby entry point for game.js's startup.
  window.Lobby = { show() { showPanel('lobby-choose'); showOverlay(); } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLobby);
  } else {
    initLobby();
  }
})();
