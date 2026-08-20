/*
 * engine.js — headless, multiplayer poker room.
 *
 * This is the online counterpart to game.js. game.js runs one hand at a time
 * in the browser with a single human and a synchronous await loop; here the
 * server owns the authoritative game for a whole room of real players (plus AI
 * fillers), and humans act asynchronously over HTTP. So the flow is a resumable
 * state machine ("drive") instead of a straight-line async function.
 *
 * Fairness is identical to the offline game: one crypto shuffle per hand, real
 * hand ranks, the same equity AI — and, crucially, each client is only ever
 * sent its OWN hole cards (see viewFor). Nobody, not even the server-run AI,
 * peeks at anyone else's cards.
 */
const shared = require('./shared-node');

const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const AI_NAMES = ['Ava', 'Ben', 'Cara', 'Dan', 'Eve', 'Finn'];
const STREET_NAMES = ['Pre-Flop', 'Flop', 'Turn', 'River'];

// Pacing (ms). Tunable; only affects how lively the table feels.
const AI_MIN = 650;
const AI_VAR = 750;
const STREET_DELAY = 950;
const SHOWDOWN_REVEAL = 900;
const HANDOVER_DELAY = 6000;
const TURN_TIMEOUT = 45000; // auto check/fold so an idle seat can't freeze a room

// ----------------------------------------------------------------------------
// Room lifecycle
// ----------------------------------------------------------------------------

function createRoom(code, opts = {}) {
  return {
    code,
    createdAt: Date.now(),
    tableSize: Math.min(6, Math.max(2, opts.tableSize || 6)),
    fillAI: opts.fillAI !== false,
    humans: [],          // lobby membership: { token, name }
    players: [],         // seats once the game starts
    phase: 'lobby',      // lobby | hand | handover | gameover
    version: 1,

    deck: [], community: [], pot: 0, currentBet: 0, minRaise: BIG_BLIND,
    smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND,
    dealerIndex: 0, sbIndex: 0, bbIndex: 0, preflopStart: 0, postflopStart: 0,
    seatOrder: [], activeIndex: -1, stage: 'Lobby', handNumber: 0, streetIndex: 0,
    handActions: [], aiDecisionLog: [], revealAll: false,
    awaiting: null, actIdx: 0, message: '', log: [],

    // injected by the server (overridable in tests)
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: h => { try { clearTimeout(h); } catch (_) {} },
    onChange: null,
    timer: null, turnTimer: null
  };
}

function touch(room) {
  room.version++;
  if (room.onChange) room.onChange(room);
}

function log(room, msg) {
  room.log.unshift(msg);
  if (room.log.length > 80) room.log.length = 80;
}

// ----------------------------------------------------------------------------
// Joining
// ----------------------------------------------------------------------------

function randomToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Add (or reconnect) a human. Returns { token, seat, reconnected }.
// - In the lobby, humans queue up and take seats when the game starts.
// - Mid-game, a returning token reconnects to its seat; a brand-new token can
//   take over an AI seat so a late friend can drop in.
function joinRoom(room, name, token) {
  const cleanName = (name || '').toString().trim().slice(0, 16);

  if (token) {
    const existingHuman = room.humans.find(h => h.token === token);
    if (existingHuman) {
      if (cleanName) existingHuman.name = cleanName;
      const seat = room.players.findIndex(p => p.token === token);
      return { token, seat, reconnected: true };
    }
    const seatByToken = room.players.findIndex(p => p.token === token);
    if (seatByToken >= 0) {
      if (cleanName) room.players[seatByToken].name = cleanName;
      return { token, seat: seatByToken, reconnected: true };
    }
  }

  const newToken = token || randomToken();
  const displayName = cleanName || `Player ${room.humans.length + 1}`;

  if (room.phase === 'lobby') {
    if (room.humans.length >= room.tableSize) throw new Error('room_full');
    room.humans.push({ token: newToken, name: displayName });
    touch(room);
    return { token: newToken, seat: -1, reconnected: false };
  }

  // Game already running: try to take over an AI seat.
  const aiSeat = room.players.find(p => p.kind === 'ai' && !p.out);
  if (!aiSeat) throw new Error('table_full');
  aiSeat.kind = 'human';
  aiSeat.token = newToken;
  aiSeat.name = displayName;
  aiSeat.personality = null;
  room.humans.push({ token: newToken, name: displayName });
  log(room, `${displayName} takes over ${AI_NAMES.includes(aiSeat.name) ? 'a seat' : aiSeat.name}.`);
  touch(room);
  return { token: newToken, seat: aiSeat.id, reconnected: false };
}

function seatByToken(room, token) {
  return room.players.findIndex(p => p.token === token);
}

// ----------------------------------------------------------------------------
// Starting the game
// ----------------------------------------------------------------------------

function makeSeat(id, kind, name, token) {
  return {
    id, name, kind, token: token || null,
    chips: START_CHIPS, hole: [], bet: 0, committed: 0, raises: 0, calls: 0,
    tendencies: { aggressiveAlpha: 1, aggressiveBeta: 3, continueAlpha: 1, continueBeta: 1 },
    folded: false, allIn: false, out: false, hasActed: false,
    lastAction: '', bestScore: null,
    personality: kind === 'ai' ? shared.makePersonality(id) : null
  };
}

function startGame(room, opts = {}) {
  if (room.phase !== 'lobby') throw new Error('already_started');
  if ('fillAI' in opts) room.fillAI = !!opts.fillAI;
  if (opts.tableSize) room.tableSize = Math.min(6, Math.max(2, opts.tableSize));

  const humanCount = room.humans.length;
  if (humanCount === 0) throw new Error('no_players');
  const total = room.fillAI ? Math.max(room.tableSize, humanCount) : humanCount;
  if (total < 2) throw new Error('need_two_players');

  room.players = [];
  let aiPicked = 0;
  for (let i = 0; i < total; i++) {
    if (i < humanCount) {
      const h = room.humans[i];
      room.players.push(makeSeat(i, 'human', h.name, h.token));
    } else {
      room.players.push(makeSeat(i, 'ai', AI_NAMES[aiPicked % AI_NAMES.length], null));
      aiPicked++;
    }
  }

  room.handNumber = 0;
  room.dealerIndex = shared.secureRandomInt(room.players.length);
  startHand(room);
}

// Rebuild everyone's stack and start a brand-new game with the same seats.
function restartGame(room) {
  for (const p of room.players) {
    p.chips = START_CHIPS;
    p.out = false;
  }
  room.handNumber = 0;
  room.dealerIndex = shared.secureRandomInt(room.players.length);
  startHand(room);
}

// ----------------------------------------------------------------------------
// Positions / dealing (ported from game.js, operating on `room`)
// ----------------------------------------------------------------------------

function seatedIndicesFrom(room, startIdx) {
  const res = [];
  const n = room.players.length;
  for (let k = 0; k < n; k++) {
    const idx = (startIdx + k) % n;
    if (!room.players[idx].out) res.push(idx);
  }
  return res;
}

function advanceDealer(room) {
  const n = room.players.length;
  room.dealerIndex = seatedIndicesFrom(room, (room.dealerIndex + 1) % n)[0];
}

function computePositions(room) {
  const order = seatedIndicesFrom(room, room.dealerIndex);
  const k = order.length;
  room.seatOrder = order;
  if (k === 2) {
    room.sbIndex = order[0];
    room.bbIndex = order[1];
    room.preflopStart = order[0];
    room.postflopStart = order[1];
  } else {
    room.sbIndex = order[1];
    room.bbIndex = order[2];
    room.preflopStart = order[3 % k];
    room.postflopStart = order[1];
  }
}

function dealHoleCards(room) {
  for (let round = 0; round < 2; round++) {
    for (const idx of room.seatOrder) room.players[idx].hole.push(room.deck.pop());
  }
}

function putChips(room, player, amount) {
  const pay = Math.min(amount, player.chips);
  player.chips -= pay;
  player.bet += pay;
  player.committed += pay;
  room.pot += pay;
  if (player.chips === 0) player.allIn = true;
  return pay;
}

function postBlinds(room) {
  const sb = room.players[room.sbIndex];
  const bb = room.players[room.bbIndex];
  putChips(room, sb, room.smallBlind);
  sb.lastAction = 'SB';
  putChips(room, bb, room.bigBlind);
  bb.lastAction = 'BB';
  room.currentBet = room.bigBlind;
  room.minRaise = room.bigBlind;
  sb.hasActed = false;
  bb.hasActed = false;
  log(room, `${sb.name} posts small blind ${room.smallBlind}, ${bb.name} posts big blind ${room.bigBlind}.`);
}

function dealStreet(room, streetIndex) {
  room.deck.pop(); // burn
  if (streetIndex === 1) {
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    log(room, `Flop: ${room.community.map(shared.cardToString).join('  ')}`);
  } else if (streetIndex === 2) {
    room.community.push(room.deck.pop());
    log(room, `Turn: ${shared.cardToString(room.community[3])}`);
  } else if (streetIndex === 3) {
    room.community.push(room.deck.pop());
    log(room, `River: ${shared.cardToString(room.community[4])}`);
  }
}

// ----------------------------------------------------------------------------
// Betting (ported from game.js)
// ----------------------------------------------------------------------------

function countInHand(room) {
  return room.players.filter(p => !p.folded && !p.out).length;
}

function bettingPossible(room) {
  return room.players.filter(p => !p.folded && !p.out && !p.allIn && p.chips > 0).length >= 2;
}

function findNextActor(room, fromIdx) {
  const n = room.players.length;
  for (let k = 0; k < n; k++) {
    const idx = (fromIdx + k) % n;
    const p = room.players[idx];
    if (p.out || p.folded || p.allIn) continue;
    if (!p.hasActed || p.bet < room.currentBet) return idx;
  }
  return -1;
}

function recordHandAction(room, player, action, details) {
  const potBefore = Math.max(1, room.pot - details.paid);
  const aggressiveThisStreet = room.handActions.filter(
    e => e.street === room.stage && (e.action === 'bet' || e.action === 'raise')
  ).length;
  room.handActions.push({
    playerId: player.id,
    street: room.stage,
    board: room.community.slice(),
    action,
    paid: details.paid,
    toCall: details.toCall,
    potBefore,
    size: details.paid / potBefore,
    isReraise: action === 'raise' && aggressiveThisStreet > 0
  });
  const t = player.tendencies;
  if (t) {
    const aggressive = action === 'bet' || action === 'raise';
    if (aggressive) t.aggressiveAlpha++; else t.aggressiveBeta++;
    if (action === 'fold') t.continueBeta++;
    else if (action !== 'check') t.continueAlpha++;
  }
}

// Turn a raw client/AI intent into a legal decision for this seat.
function normalizeAction(room, player, intent) {
  const toCall = room.currentBet - player.bet;
  const maxTotal = player.chips + player.bet;
  const kind = intent && intent.action;
  if (kind === 'fold') return { action: 'fold' };
  if (kind === 'check' || kind === 'call') return toCall <= 0 ? { action: 'check' } : { action: 'call' };
  if (kind === 'allin') return maxTotal > room.currentBet ? { action: 'raise', amount: maxTotal } : { action: 'call' };
  if (kind === 'raise') {
    let minTotal = room.currentBet + room.minRaise;
    if (minTotal > maxTotal) minTotal = maxTotal;
    let amt = Math.round(Number(intent.amount) || 0);
    amt = Math.max(minTotal, Math.min(maxTotal, amt));
    return { action: 'raise', amount: amt };
  }
  return toCall <= 0 ? { action: 'check' } : { action: 'call' };
}

function applyAction(room, player, decision) {
  const oldCurrent = room.currentBet;
  const toCall = room.currentBet - player.bet;

  if (decision.action === 'fold') {
    player.folded = true;
    player.hasActed = true;
    recordHandAction(room, player, 'fold', { paid: 0, toCall });
    player.lastAction = 'Fold';
    log(room, `${player.name} folds.`);
    return;
  }
  if (decision.action === 'check') {
    player.hasActed = true;
    recordHandAction(room, player, 'check', { paid: 0, toCall });
    player.lastAction = 'Check';
    log(room, `${player.name} checks.`);
    return;
  }
  if (decision.action === 'call') {
    const paid = putChips(room, player, toCall);
    player.calls++;
    player.hasActed = true;
    recordHandAction(room, player, 'call', { paid, toCall });
    player.lastAction = player.allIn ? `All-In ${player.bet}` : `Call ${player.bet}`;
    log(room, `${player.name} ${player.allIn ? 'calls all-in for ' + paid : 'calls ' + paid}.`);
    return;
  }

  // bet / raise
  let target = decision.amount;
  const maxTotal = player.chips + player.bet;
  if (target > maxTotal) target = maxTotal;
  const paid = putChips(room, player, target - player.bet);
  const inc = player.bet - oldCurrent;
  if (inc > 0) player.raises++; else player.calls++;
  if (player.bet > room.currentBet) {
    if (inc >= room.minRaise) {
      room.minRaise = inc;
      for (const q of room.players) {
        if (q !== player && !q.folded && !q.out && !q.allIn) q.hasActed = false;
      }
    }
    room.currentBet = player.bet;
  }
  player.hasActed = true;
  recordHandAction(room, player, oldCurrent === 0 ? 'bet' : 'raise', { paid, toCall });
  const verb = oldCurrent === 0 ? 'bets' : 'raises to';
  player.lastAction = (player.allIn ? 'All-In ' : oldCurrent === 0 ? 'Bet ' : 'Raise ') + player.bet;
  log(room, `${player.name} ${verb} ${player.bet}${player.allIn ? ' (all-in)' : ''}.`);
}

function resetBetsForNewStreet(room) {
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  for (const p of room.players) {
    p.bet = 0;
    if (!p.folded && !p.out && !p.allIn) p.hasActed = false;
    else p.hasActed = true;
  }
}

function recordAIDecision(room, player, decision) {
  const equity = Math.round((decision.equity || 0) * 100);
  const potOdds = decision.potOdds === undefined ? '' : `, price ${Math.round(decision.potOdds * 100)}%`;
  const position = decision.position > 0.02 ? 'in position' : decision.position < -0.02 ? 'out of position' : 'neutral position';
  room.aiDecisionLog.unshift(
    `${player.name} (${player.personality.label}) ${decision.action}s: ${decision.reason}; ` +
    `equity ${equity}%${potOdds}; ${position}; ranges ${decision.ranges || 'unread'}.`
  );
  room.aiDecisionLog.length = Math.min(room.aiDecisionLog.length, 12);
}

// ----------------------------------------------------------------------------
// The driver: advance the hand as far as it can, pausing for human input.
// ----------------------------------------------------------------------------

function clearTurnTimer(room) {
  if (room.turnTimer) { room.cancel(room.turnTimer); room.turnTimer = null; }
}
function clearPacing(room) {
  if (room.timer) { room.cancel(room.timer); room.timer = null; }
}

function setAwaiting(room, seat) {
  const p = room.players[seat];
  const toCall = room.currentBet - p.bet;
  const maxTotal = p.chips + p.bet;
  let minRaiseTotal = room.currentBet + room.minRaise;
  if (minRaiseTotal > maxTotal) minRaiseTotal = maxTotal;
  room.awaiting = {
    seat,
    toCall,
    minRaiseTotal,
    maxTotal,
    canRaise: maxTotal > room.currentBet,
    canCheck: toCall <= 0
  };
  room.activeIndex = seat;
  clearTurnTimer(room);
  room.turnTimer = room.schedule(() => {
    if (room.phase !== 'hand' || !room.awaiting || room.awaiting.seat !== seat) return;
    const decision = (room.currentBet - p.bet) > 0 ? { action: 'fold' } : { action: 'check' };
    applyAction(room, p, decision);
    room.awaiting = null;
    room.activeIndex = -1;
    room.actIdx = (seat + 1) % room.players.length;
    touch(room);
    drive(room);
  }, TURN_TIMEOUT);
}

function drive(room) {
  if (room.phase !== 'hand' || room.awaiting) return;

  if (countInHand(room) === 1) { endByFolds(room); return; }

  const actor = findNextActor(room, room.actIdx);
  if (actor === -1) { proceedStreet(room); return; }

  const player = room.players[actor];
  room.activeIndex = actor;

  if (player.kind === 'human') {
    setAwaiting(room, actor);
    touch(room);
    return;
  }

  // AI seat: think for a beat, then act.
  clearPacing(room);
  room.timer = room.schedule(() => {
    if (room.phase !== 'hand') return;
    // A late human may have taken over this seat while we waited.
    if (player.kind !== 'ai') { drive(room); return; }
    const decision = shared.decideAction(player, room);
    applyAction(room, player, decision);
    recordAIDecision(room, player, decision);
    room.activeIndex = -1;
    room.actIdx = (actor + 1) % room.players.length;
    touch(room);
    drive(room);
  }, AI_MIN + Math.random() * AI_VAR);
}

function proceedStreet(room) {
  if (countInHand(room) === 1) { endByFolds(room); return; }
  if (room.streetIndex >= 3) { showdown(room); return; }

  clearPacing(room);
  room.timer = room.schedule(() => {
    if (room.phase !== 'hand') return;
    room.streetIndex++;
    resetBetsForNewStreet(room);
    dealStreet(room, room.streetIndex);
    room.stage = STREET_NAMES[room.streetIndex];
    room.actIdx = room.postflopStart;
    touch(room);
    drive(room);
  }, STREET_DELAY);
}

// ----------------------------------------------------------------------------
// Showdown / pots (ported from game.js)
// ----------------------------------------------------------------------------

function buildPots(room) {
  const contribs = room.players
    .filter(p => p.committed > 0)
    .map(p => ({ player: p, remaining: p.committed, folded: p.folded }));
  const pots = [];
  while (true) {
    const active = contribs.filter(c => c.remaining > 0);
    if (active.length === 0) break;
    const min = Math.min(...active.map(c => c.remaining));
    let amount = 0;
    const eligible = [];
    for (const c of active) {
      amount += min;
      c.remaining -= min;
      if (!c.folded) eligible.push(c.player);
    }
    pots.push({ amount, eligible });
  }
  return pots;
}

function distributePot(room, pot, index, total) {
  const contenders = pot.eligible.filter(p => !p.folded);
  if (contenders.length === 0) return;
  let best = null;
  let winners = [];
  for (const p of contenders) {
    const score = shared.evaluate7([...p.hole, ...room.community]);
    p.bestScore = score;
    const cmp = best ? shared.compareScores(score, best) : 1;
    if (cmp > 0) { best = score; winners = [p]; }
    else if (cmp === 0) winners.push(p);
  }
  const share = Math.floor(pot.amount / winners.length);
  let remainder = pot.amount - share * winners.length;
  for (const w of winners) w.chips += share;
  if (remainder > 0) {
    const order = seatedIndicesFrom(room, (room.dealerIndex + 1) % room.players.length).map(i => room.players[i]);
    for (const pl of order) {
      if (remainder <= 0) break;
      if (winners.includes(pl)) { pl.chips += 1; remainder -= 1; }
    }
  }
  const label = total > 1 ? (index === 0 ? 'Main pot' : `Side pot ${index}`) : 'Pot';
  log(room, `${label} ${pot.amount} -> ${winners.map(w => w.name).join(', ')} (${shared.handName(best)}).`);
}

function showdown(room) {
  room.stage = 'Showdown';
  room.revealAll = true;
  for (const p of room.players) {
    if (!p.folded && !p.out) p.bestScore = shared.evaluate7([...p.hole, ...room.community]);
  }
  room.activeIndex = -1;
  touch(room); // reveal the cards first, build the suspense, then pay out
  clearPacing(room);
  room.timer = room.schedule(() => {
    const pots = buildPots(room);
    pots.forEach((pot, i) => distributePot(room, pot, i, pots.length));
    room.pot = 0;
    settleHandEnd(room);
  }, SHOWDOWN_REVEAL);
}

function endByFolds(room) {
  const winner = room.players.find(p => !p.folded && !p.out);
  winner.chips += room.pot;
  log(room, `${winner.name} wins ${room.pot} — everyone else folded.`);
  room.pot = 0;
  room.activeIndex = -1;
  settleHandEnd(room);
}

function settleHandEnd(room) {
  clearTurnTimer(room);
  for (const p of room.players) {
    if (!p.out && p.chips <= 0) {
      p.out = true;
      p.lastAction = 'Out';
      log(room, `${p.name} is eliminated.`);
    }
  }
  const remaining = room.players.filter(p => !p.out);
  if (remaining.length === 1) {
    room.phase = 'gameover';
    room.message = `${remaining[0].name} wins the game!`;
    room.activeIndex = -1;
    touch(room);
    return;
  }
  room.phase = 'handover';
  room.message = 'Hand complete.';
  touch(room);
  clearPacing(room);
  room.timer = room.schedule(() => {
    if (room.phase !== 'handover') return;
    advanceDealer(room);
    startHand(room);
  }, HANDOVER_DELAY);
}

// Any player may end the wait between hands (or start a fresh game after one).
function requestNextHand(room) {
  if (room.phase === 'gameover') { clearPacing(room); restartGame(room); return; }
  if (room.phase !== 'handover') return;
  clearPacing(room);
  advanceDealer(room);
  startHand(room);
}

// ----------------------------------------------------------------------------
// A single hand
// ----------------------------------------------------------------------------

function startHand(room) {
  room.handNumber++;
  room.deck = shared.freshShuffledDeck();
  room.community = [];
  room.handActions = [];
  room.aiDecisionLog = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.revealAll = false;
  room.activeIndex = -1;
  room.awaiting = null;
  room.streetIndex = 0;
  room.message = '';

  for (const p of room.players) {
    p.hole = [];
    p.bet = 0;
    p.committed = 0;
    p.raises = 0;
    p.calls = 0;
    p.folded = p.out;
    p.allIn = false;
    p.hasActed = p.out;
    p.lastAction = p.out ? 'Out' : '';
    p.bestScore = null;
  }

  computePositions(room);
  dealHoleCards(room);
  log(room, `--- Hand #${room.handNumber} --- Dealer: ${room.players[room.dealerIndex].name}`);
  postBlinds(room);
  room.stage = 'Pre-Flop';
  room.phase = 'hand';
  room.actIdx = room.preflopStart;
  touch(room);
  drive(room);
}

// ----------------------------------------------------------------------------
// Human actions
// ----------------------------------------------------------------------------

function submitAction(room, token, intent) {
  if (room.phase !== 'hand' || !room.awaiting) throw new Error('not_your_turn');
  const seat = seatByToken(room, token);
  if (seat < 0 || seat !== room.awaiting.seat) throw new Error('not_your_turn');
  const player = room.players[seat];
  clearTurnTimer(room);
  const decision = normalizeAction(room, player, intent);
  applyAction(room, player, decision);
  room.awaiting = null;
  room.activeIndex = -1;
  room.actIdx = (seat + 1) % room.players.length;
  touch(room);
  drive(room);
}

// ----------------------------------------------------------------------------
// Client-facing view: reveals ONLY the requesting player's hole cards.
// ----------------------------------------------------------------------------

function viewFor(room, token) {
  const you = seatByToken(room, token);
  const inLobby = room.humans.some(h => h.token === token);

  const players = room.players.map(p => {
    const mine = p.id === you;
    const revealed = room.revealAll && !p.folded && !p.out;
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      chips: p.chips,
      bet: p.bet,
      committed: p.committed,
      folded: p.folded,
      out: p.out,
      allIn: p.allIn,
      lastAction: p.lastAction,
      isYou: mine,
      hasCards: p.hole.length > 0 && !p.out,
      hole: (mine || revealed) ? p.hole : null,
      handName: revealed && p.bestScore ? shared.handName(p.bestScore) : null,
      isDealer: p.id === room.dealerIndex,
      isSB: p.id === room.sbIndex,
      isBB: p.id === room.bbIndex,
      isActive: p.id === room.activeIndex
    };
  });

  return {
    version: room.version,
    code: room.code,
    phase: room.phase,
    you,
    tableSize: room.tableSize,
    fillAI: room.fillAI,
    stage: room.stage,
    pot: room.pot,
    currentBet: room.currentBet,
    bigBlind: room.bigBlind,
    community: room.community.slice(),
    handNumber: room.handNumber,
    message: room.message,
    activeIndex: room.activeIndex,
    revealAll: room.revealAll,
    players,
    awaiting: room.awaiting && room.awaiting.seat === you ? room.awaiting : null,
    lobby: room.phase === 'lobby' ? {
      you: inLobby,
      players: room.humans.map(h => h.name),
      isHost: room.humans.length > 0 && room.humans[0].token === token,
      canStart: room.humans.length >= 1
    } : null,
    log: room.log.slice(0, 60),
    aiLog: room.aiDecisionLog.slice(0, 12)
  };
}

module.exports = {
  START_CHIPS,
  createRoom,
  joinRoom,
  startGame,
  submitAction,
  requestNextHand,
  viewFor,
  seatByToken,
  // exposed for tests
  startHand,
  drive,
  buildPots,
  countInHand
};
