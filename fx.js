/*
 * fx.js — table "feel": chip graphics, chips sweeping into the pot, and sound.
 *
 * Shared by the offline game (game.js) and the online table (online.js) so both
 * look and sound the same. Everything here is presentation only — it never
 * touches game state, so it's safe to call from either renderer.
 *
 * Sound is synthesized with the Web Audio API (no files), off unless the player
 * turns it on, and started on the first click (browsers require a gesture).
 */
const FX = (function () {
  // ---- Chips ----------------------------------------------------------------

  function chipColorFor(amount) {
    if (amount >= 1000) return 'gold';
    if (amount >= 500) return 'black';
    if (amount >= 100) return 'green';
    if (amount >= 25) return 'red';
    return 'white';
  }

  // A chip disc + the amount, for showing a player's current bet.
  function chipHTML(amount) {
    if (!amount) return '';
    const c = chipColorFor(amount);
    return `<span class="chip ${c}"></span><span class="chip-amt">${amount}</span>`;
  }

  // ---- Flying chips ---------------------------------------------------------

  function flyChip(fromRect, toRect, opts) {
    opts = opts || {};
    const chip = document.createElement('div');
    chip.className = 'fx-chip ' + (opts.color || 'gold');
    document.body.appendChild(chip);
    const sx = fromRect.left + fromRect.width / 2;
    const sy = fromRect.top + fromRect.height / 2;
    const ex = toRect.left + toRect.width / 2;
    const ey = toRect.top + toRect.height / 2;
    chip.style.left = sx + 'px';
    chip.style.top = sy + 'px';
    requestAnimationFrame(() => {
      chip.style.transition = 'transform .45s cubic-bezier(.4,.7,.3,1), opacity .45s ease-in';
      chip.style.transitionDelay = (opts.delay || 0) + 'ms';
      chip.style.transform = `translate(${ex - sx}px, ${ey - sy}px) scale(0.7)`;
      chip.style.opacity = '0.15';
    });
    setTimeout(() => chip.remove(), 550 + (opts.delay || 0));
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return r.width && r.height ? r : null;
  }

  // Sweep every visible bet chip into the pot. Returns a promise for the pause.
  function sweepBetsToPot() {
    const pot = document.getElementById('pot');
    const potRect = pot && rectOf(pot);
    if (!potRect) return Promise.resolve();
    let n = 0;
    document.querySelectorAll('.p-bet').forEach(bet => {
      const chip = bet.querySelector('.chip');
      const r = chip && rectOf(bet);
      if (!r) return;
      const color = (chip.className.match(/chip (\w+)/) || [])[1] || 'gold';
      flyChip(r, potRect, { color, delay: n * 45 });
      n++;
    });
    if (n) sound('chip');
    return new Promise(res => setTimeout(res, n ? 450 : 0));
  }

  // Slide the pot over to the winner's seat.
  function potToWinner(winnerEl) {
    const pot = document.getElementById('pot');
    const potRect = pot && rectOf(pot);
    const toRect = winnerEl && rectOf(winnerEl);
    if (!potRect || !toRect) return;
    for (let i = 0; i < 4; i++) flyChip(potRect, toRect, { color: 'gold', delay: i * 60 });
  }

  // ---- Sound ----------------------------------------------------------------

  let audio = null;
  let muted = true;
  try { muted = localStorage.getItem('rd-sound') !== 'on'; } catch (_) {}

  function actx() {
    if (!audio) {
      try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return null; }
    }
    if (audio && audio.state === 'suspended') audio.resume();
    return audio;
  }

  function tone(freq, dur, type, gain) {
    const a = actx();
    if (!a) return;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    o.connect(g); g.connect(a.destination);
    g.gain.setValueAtTime(gain || 0.05, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.start();
    o.stop(a.currentTime + dur);
  }

  function noise(dur, cutoff, gain) {
    const a = actx();
    if (!a) return;
    const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 1000;
    const g = a.createGain(); g.gain.value = gain || 0.08;
    src.connect(f); f.connect(g); g.connect(a.destination);
    src.start();
  }

  function sound(kind) {
    if (muted) return;
    switch (kind) {
      case 'deal': noise(0.045, 1400, 0.07); break;
      case 'chip': tone(660, 0.06, 'triangle', 0.06); tone(880, 0.05, 'triangle', 0.04); break;
      case 'check': tone(300, 0.06, 'square', 0.05); break;
      case 'call': tone(520, 0.06, 'triangle', 0.05); break;
      case 'fold': noise(0.06, 480, 0.06); break;
      case 'raise': tone(500, 0.09, 'sawtooth', 0.05); break;
      case 'win': tone(660, 0.12); setTimeout(() => tone(880, 0.14), 90); setTimeout(() => tone(1100, 0.18), 190); break;
    }
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('rd-sound', m ? 'off' : 'on'); } catch (_) {}
    if (!m) actx(); // warm up the context on unmute
  }
  function isMuted() { return muted; }

  // Map an action string to its sound.
  function actionSound(action) {
    if (action === 'fold') sound('fold');
    else if (action === 'check') sound('check');
    else if (action === 'call') sound('call');
    else if (action === 'bet' || action === 'raise') sound('raise');
  }

  return { chipHTML, chipColorFor, sweepBetsToPot, potToWinner, sound, actionSound, setMuted, isMuted };
})();

if (typeof window !== 'undefined') window.FX = FX;
