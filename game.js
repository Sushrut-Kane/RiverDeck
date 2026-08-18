/*
 * game.js — Riverdeck poker engine + UI.
 *
 * Design goals (in priority order):
 *   1. Honest & fair. One cryptographic shuffle per hand. Cards are dealt once
 *      and never altered. No player (including the AI) sees another player's
 *      hole cards. Nothing is rigged for or against you.
 *   2. Complete rules. Blinds, four betting streets, check/call/bet/raise/fold,
 *      all-in with correct side pots, split pots with odd-chip handling,
 *      dealer-button rotation, and elimination down to a single winner.
 *   3. Simple, readable UI. Function over decoration.
 */

const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const PLAYER_NAMES = ['You', 'Ava', 'Ben', 'Cara', 'Dan', 'Eve'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const game = {
  players: [],
  human: null,
  deck: [],
  community: [],
  pot: 0,
  currentBet: 0,
  minRaise: BIG_BLIND,
  smallBlind: SMALL_BLIND,
  bigBlind: BIG_BLIND,
  dealerIndex: 0,
  sbIndex: 0,
  bbIndex: 0,
  preflopStart: 0,
  postflopStart: 0,
  seatOrder: [],
  activeIndex: -1,
  stage: 'Idle',
  handNumber: 0,
  revealAll: false,
  busy: false
};

// Resolver for the promise the engine awaits while the human decides.
let pendingHumanResolve = null;

// ----------------------------------------------------------------------------
// Player / hand setup
// ----------------------------------------------------------------------------

function buildPlayers() {
  game.players = PLAYER_NAMES.map((name, i) => ({
    id: i,
    name,
    isHuman: i === 0,
    chips: START_CHIPS,
    hole: [],
    bet: 0,        // chips wagered in the current betting round
    committed: 0,  // chips wagered across the whole hand (for side pots)
    raises: 0,     // bets/raises made this hand (read by opponents)
    calls: 0,      // calls made this hand (read by opponents)
    folded: false,
    allIn: false,
    out: false,    // eliminated from the tournament
    hasActed: false,
    lastAction: '',
    bestScore: null,
    personality: i === 0 ? null : makePersonality()
  }));
  game.human = game.players[0];
}

// Seated (still-in-the-tournament) seat indices, clockwise from startIdx.
function seatedIndicesFrom(startIdx) {
  const res = [];
  const n = game.players.length;
  for (let k = 0; k < n; k++) {
    const idx = (startIdx + k) % n;
    if (!game.players[idx].out) res.push(idx);
  }
  return res;
}

function advanceDealer() {
  const n = game.players.length;
  const order = seatedIndicesFrom((game.dealerIndex + 1) % n);
  game.dealerIndex = order[0];
}

// Work out button, blinds, and first-to-act seats for the current hand.
function computePositions() {
  const order = seatedIndicesFrom(game.dealerIndex); // dealer is order[0]
  const k = order.length;
  game.seatOrder = order;
  if (k === 2) {
    // Heads-up: dealer posts the small blind and acts first pre-flop.
    game.sbIndex = order[0];
    game.bbIndex = order[1];
    game.preflopStart = order[0];
    game.postflopStart = order[1];
  } else {
    game.sbIndex = order[1];
    game.bbIndex = order[2];
    game.preflopStart = order[3 % k];
    game.postflopStart = order[1];
  }
}

function dealHoleCards() {
  // Two cards each, one at a time around the table (order is irrelevant to
  // fairness because the deck is already uniformly shuffled).
  for (let round = 0; round < 2; round++) {
    for (const idx of game.seatOrder) {
      game.players[idx].hole.push(game.deck.pop());
    }
  }
}

function putChips(player, amount) {
  const pay = Math.min(amount, player.chips);
  player.chips -= pay;
  player.bet += pay;
  player.committed += pay;
  game.pot += pay;
  if (player.chips === 0) player.allIn = true;
  return pay;
}

function postBlinds() {
  const sb = game.players[game.sbIndex];
  const bb = game.players[game.bbIndex];
  putChips(sb, game.smallBlind);
  sb.lastAction = 'SB';
  putChips(bb, game.bigBlind);
  bb.lastAction = 'BB';
  game.currentBet = game.bigBlind;
  game.minRaise = game.bigBlind;
  // Blinds are forced; both still get to act on their turn.
  sb.hasActed = false;
  bb.hasActed = false;
  log(`${sb.name} posts small blind ${game.smallBlind}, ${bb.name} posts big blind ${game.bigBlind}.`);
}

// ----------------------------------------------------------------------------
// Dealing the board
// ----------------------------------------------------------------------------

function burn() {
  game.deck.pop(); // burn a card before each street, as in a real deal
}

function dealFlop() {
  burn();
  game.community.push(game.deck.pop(), game.deck.pop(), game.deck.pop());
  log(`Flop: ${game.community.map(cardToString).join('  ')}`);
}

function dealTurn() {
  burn();
  game.community.push(game.deck.pop());
  log(`Turn: ${cardToString(game.community[3])}`);
}

function dealRiver() {
  burn();
  game.community.push(game.deck.pop());
  log(`River: ${cardToString(game.community[4])}`);
}

// ----------------------------------------------------------------------------
// Betting
// ----------------------------------------------------------------------------

function countInHand() {
  return game.players.filter(p => !p.folded && !p.out).length;
}

// At least two players still have chips to wager against each other.
function bettingPossible() {
  return game.players.filter(p => !p.folded && !p.out && !p.allIn && p.chips > 0).length >= 2;
}

// Next seat (clockwise from fromIdx) that still owes an action, or -1.
function findNextActor(fromIdx) {
  const n = game.players.length;
  for (let k = 0; k < n; k++) {
    const idx = (fromIdx + k) % n;
    const p = game.players[idx];
    if (p.out || p.folded || p.allIn) continue;
    if (!p.hasActed || p.bet < game.currentBet) return idx;
  }
  return -1;
}

function applyAction(player, decision) {
  const oldCurrent = game.currentBet;
  const toCall = game.currentBet - player.bet;

  if (decision.action === 'fold') {
    player.folded = true;
    player.hasActed = true;
    player.lastAction = 'Fold';
    log(`${player.name} folds.`);
    return;
  }

  if (decision.action === 'check') {
    player.hasActed = true;
    player.lastAction = 'Check';
    log(`${player.name} checks.`);
    return;
  }

  if (decision.action === 'call') {
    const paid = putChips(player, toCall);
    player.calls++;
    player.hasActed = true;
    player.lastAction = player.allIn ? `All-In ${player.bet}` : `Call ${player.bet}`;
    log(`${player.name} ${player.allIn ? 'calls all-in for ' + paid : 'calls ' + paid}.`);
    return;
  }

  // raise / bet
  let target = decision.amount;
  const maxTotal = player.chips + player.bet;
  if (target > maxTotal) target = maxTotal;
  putChips(player, target - player.bet);

  const inc = player.bet - oldCurrent;
  if (inc > 0) player.raises++;        // genuine bet/raise
  else player.calls++;                 // short all-in that didn't raise the price
  if (player.bet > game.currentBet) {
    if (inc >= game.minRaise) {
      game.minRaise = inc;
      // A full-size raise reopens the action for everyone still in.
      for (const q of game.players) {
        if (q !== player && !q.folded && !q.out && !q.allIn) q.hasActed = false;
      }
    }
    game.currentBet = player.bet;
  }
  player.hasActed = true;

  const verb = oldCurrent === 0 ? 'bets' : 'raises to';
  player.lastAction =
    (player.allIn ? 'All-In ' : oldCurrent === 0 ? 'Bet ' : 'Raise ') + player.bet;
  log(`${player.name} ${verb} ${player.bet}${player.allIn ? ' (all-in)' : ''}.`);
}

async function runBettingRound(startIdx) {
  let idx = startIdx;
  while (true) {
    const actorIdx = findNextActor(idx);
    if (actorIdx === -1) break;

    const player = game.players[actorIdx];
    game.activeIndex = actorIdx;
    render();

    let decision;
    if (player.isHuman) {
      decision = await requestHumanAction(player);
    } else {
      await sleep(500 + Math.random() * 600);
      decision = decideAction(player, game);
    }

    applyAction(player, decision);
    game.activeIndex = -1;
    render();
    await sleep(220);

    if (countInHand() === 1) break; // everyone else folded
    idx = (actorIdx + 1) % game.players.length;
  }
}

function resetBetsForNewStreet() {
  game.currentBet = 0;
  game.minRaise = game.bigBlind;
  for (const p of game.players) {
    p.bet = 0;
    if (!p.folded && !p.out && !p.allIn) p.hasActed = false;
    else p.hasActed = true;
  }
}

// ----------------------------------------------------------------------------
// Human input (buttons resolve the awaited promise)
// ----------------------------------------------------------------------------

function requestHumanAction(player) {
  showHumanControls(player);
  return new Promise(resolve => {
    pendingHumanResolve = decision => {
      pendingHumanResolve = null;
      hideHumanControls();
      resolve(decision);
    };
  });
}

function submitHumanAction(decision) {
  if (pendingHumanResolve) pendingHumanResolve(decision);
}

// ----------------------------------------------------------------------------
// Showdown, side pots, and pot distribution
// ----------------------------------------------------------------------------

// Split every player's contribution into main/side pots with eligibility.
function buildPots() {
  const contribs = game.players
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

function distributePot(pot, index, total) {
  const contenders = pot.eligible.filter(p => !p.folded);
  if (contenders.length === 0) return;

  let best = null;
  let winners = [];
  for (const p of contenders) {
    const score = evaluate7([...p.hole, ...game.community]);
    p.bestScore = score;
    const cmp = best ? compareScores(score, best) : 1;
    if (cmp > 0) {
      best = score;
      winners = [p];
    } else if (cmp === 0) {
      winners.push(p);
    }
  }

  const share = Math.floor(pot.amount / winners.length);
  let remainder = pot.amount - share * winners.length;
  for (const w of winners) w.chips += share;

  // Odd chips go to the first eligible winner(s) left of the dealer.
  if (remainder > 0) {
    const order = seatedIndicesFrom((game.dealerIndex + 1) % game.players.length)
      .map(i => game.players[i]);
    for (const pl of order) {
      if (remainder <= 0) break;
      if (winners.includes(pl)) {
        pl.chips += 1;
        remainder -= 1;
      }
    }
  }

  const label = total > 1 ? (index === 0 ? 'Main pot' : `Side pot ${index}`) : 'Pot';
  const names = winners.map(w => w.name).join(', ');
  log(`${label} ${pot.amount} -> ${names} (${handName(best)}).`);
}

async function showdown() {
  game.stage = 'Showdown';
  game.revealAll = true;
  // Make sure every shown hand has a computed rank for display.
  for (const p of game.players) {
    if (!p.folded && !p.out) p.bestScore = evaluate7([...p.hole, ...game.community]);
  }
  render();
  await sleep(400);

  const pots = buildPots();
  pots.forEach((pot, i) => distributePot(pot, i, pots.length));
  game.pot = 0;
  render();
  finishHand();
}

function endByFolds() {
  const winner = game.players.find(p => !p.folded && !p.out);
  winner.chips += game.pot;
  log(`${winner.name} wins ${game.pot} — everyone else folded.`);
  game.pot = 0;
  render();
  finishHand();
}

// ----------------------------------------------------------------------------
// Hand flow
// ----------------------------------------------------------------------------

async function playHand() {
  const streets = [
    { name: 'Pre-Flop', deal: null, start: () => game.preflopStart },
    { name: 'Flop', deal: dealFlop, start: () => game.postflopStart },
    { name: 'Turn', deal: dealTurn, start: () => game.postflopStart },
    { name: 'River', deal: dealRiver, start: () => game.postflopStart }
  ];

  for (let s = 0; s < streets.length; s++) {
    const st = streets[s];
    if (s > 0) {
      resetBetsForNewStreet();
      st.deal();
      game.stage = st.name;
      render();
      await sleep(700);
    } else {
      game.stage = st.name;
      render();
    }

    if (countInHand() > 1 && bettingPossible()) {
      await runBettingRound(st.start());
    }

    if (countInHand() === 1) {
      endByFolds();
      return;
    }
  }

  await showdown();
}

async function startHand() {
  game.busy = true;
  hideHumanControls();
  document.getElementById('btn-next-hand').style.display = 'none';

  game.handNumber++;
  game.deck = freshShuffledDeck();
  game.community = [];
  game.pot = 0;
  game.currentBet = 0;
  game.minRaise = game.bigBlind;
  game.revealAll = false;
  game.activeIndex = -1;

  for (const p of game.players) {
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

  computePositions();
  dealHoleCards();
  log(`--- Hand #${game.handNumber} --- Dealer: ${game.players[game.dealerIndex].name}`);
  postBlinds();
  game.stage = 'Pre-Flop';
  render();
  await sleep(500);

  await playHand();
  game.busy = false;
}

function finishHand() {
  for (const p of game.players) {
    if (!p.out && p.chips <= 0) {
      p.out = true;
      p.lastAction = 'Out';
      log(`${p.name} is eliminated.`);
    }
  }
  render();

  const remaining = game.players.filter(p => !p.out);
  if (remaining.length === 1) {
    endGame(`${remaining[0].name} win${remaining[0].isHuman ? '' : 's'} the game!`);
    return;
  }
  if (game.human.out) {
    endGame('You are out of chips. Game over.');
    return;
  }
  document.getElementById('btn-next-hand').style.display = 'inline-block';
}

function endGame(message) {
  setMessage(message);
  document.getElementById('btn-next-hand').style.display = 'none';
  document.getElementById('btn-new-game').style.display = 'inline-block';
}

function nextHand() {
  setMessage('');
  advanceDealer();
  startHand();
}

function newGame() {
  document.getElementById('btn-new-game').style.display = 'none';
  setMessage('');
  clearLog();
  buildPlayers();
  game.handNumber = 0;
  game.dealerIndex = secureRandomInt(game.players.length);
  startHand();
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------

function setMessage(text) {
  document.getElementById('message').textContent = text;
}

function log(msg) {
  const el = document.getElementById('log');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = msg;
  el.prepend(line);
  while (el.children.length > 60) el.removeChild(el.lastChild);
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
}

// Small round initial used as a player avatar.
function avatarHTML(p) {
  return `<span class="avatar" data-seat="${p.id}">${p.name.charAt(0)}</span>`;
}

function cardHTML(card, faceDown) {
  if (faceDown || !card) {
    return '<div class="card back"><span class="card-logo">\u2663</span></div>';
  }
  const red = isRedSuit(card.suit) ? ' red' : '';
  const r = rankLabel(card.rank);
  const s = suitSymbol(card.suit);
  return `<div class="card${red}">` +
    `<span class="corner"><span class="rank">${r}</span><span class="suit">${s}</span></span>` +
    `<span class="pip">${s}</span>` +
    `</div>`;
}

function positionBadge(idx) {
  if (idx === game.dealerIndex) return '<span class="badge dealer">D</span>';
  if (idx === game.sbIndex) return '<span class="badge">SB</span>';
  if (idx === game.bbIndex) return '<span class="badge">BB</span>';
  return '';
}

function renderOpponents() {
  const container = document.getElementById('opponents');
  container.innerHTML = '';
  for (let i = 1; i < game.players.length; i++) {
    const p = game.players[i];
    const box = document.createElement('div');
    box.className = 'player';
    if (i === game.activeIndex) box.classList.add('active');
    if (p.folded && !p.out) box.classList.add('folded');
    if (p.out) box.classList.add('out');

    const reveal = game.revealAll && !p.folded && !p.out;
    const cards = p.out
      ? ''
      : `<div class="cards">${cardHTML(p.hole[0], !reveal)}${cardHTML(p.hole[1], !reveal)}</div>`;
    const handInfo = reveal && p.bestScore
      ? `<div class="hand-name">${handName(p.bestScore)}</div>`
      : '';

    box.innerHTML =
      `<div class="p-head"><span class="who">${avatarHTML(p)}<span class="p-name">${p.name}</span></span>${positionBadge(i)}</div>` +
      cards +
      `<div class="p-chips">${p.out ? 'OUT' : p.chips + ' chips'}</div>` +
      `<div class="p-bet">${p.bet > 0 ? 'bet ' + p.bet : ''}</div>` +
      `<div class="p-action">${p.lastAction || ''}</div>` +
      handInfo;
    container.appendChild(box);
  }
}

function renderBoard() {
  document.getElementById('stage-label').textContent = game.stage;
  document.getElementById('pot').textContent = `Pot: ${game.pot}`;
  const board = document.getElementById('community');
  board.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    board.innerHTML += game.community[i]
      ? cardHTML(game.community[i], false)
      : '<div class="card placeholder"></div>';
  }
}

function renderHuman() {
  const p = game.human;
  const box = document.getElementById('human');
  box.classList.toggle('active', game.activeIndex === 0);
  box.classList.toggle('folded', p.folded && !p.out);
  box.classList.toggle('out', p.out);

  document.getElementById('human-cards').innerHTML =
    `${cardHTML(p.hole[0], p.out)}${cardHTML(p.hole[1], p.out)}`;

  let handText = '';
  if (!p.out && p.hole.length === 2 && game.community.length >= 3) {
    handText = 'Your hand: ' + handName(evaluate7([...p.hole, ...game.community]));
  }
  document.getElementById('human-hand').textContent = handText;

  document.getElementById('human-info').innerHTML =
    `<span class="who">${avatarHTML(p)}<span class="p-name">${p.name}</span></span>${positionBadge(0)}` +
    `<span class="p-chips">${p.out ? 'OUT' : p.chips + ' chips'}</span>` +
    `<span class="p-bet">${p.bet > 0 ? 'bet ' + p.bet : ''}</span>` +
    `<span class="p-action">${p.lastAction || ''}</span>`;
}

function render() {
  renderOpponents();
  renderBoard();
  renderHuman();
  renderStatus();
}

// Whose turn it is, shown in the sticky action bar.
function renderStatus() {
  const el = document.getElementById('turn-status');
  if (!el) return;
  const i = game.activeIndex;
  if (i === 0) el.textContent = 'Your move';
  else if (i > 0) el.textContent = `${game.players[i].name} is thinking\u2026`;
  else el.textContent = '';
}

// ----------------------------------------------------------------------------
// Human control panel
// ----------------------------------------------------------------------------

function showHumanControls(player) {
  const panel = document.getElementById('controls');
  panel.style.display = 'flex';

  // Keep your cards and the controls together in view on small screens.
  document.getElementById('human').scrollIntoView({ behavior: 'smooth', block: 'center' });

  const toCall = game.currentBet - player.bet;
  const maxTotal = player.chips + player.bet;

  const checkCall = document.getElementById('btn-check-call');
  if (toCall <= 0) {
    checkCall.textContent = 'Check';
    checkCall.dataset.mode = 'check';
    checkCall.disabled = false;
  } else {
    const callAmount = Math.min(toCall, player.chips);
    checkCall.textContent = callAmount >= player.chips ? `Call ${callAmount} (All-In)` : `Call ${callAmount}`;
    checkCall.dataset.mode = 'call';
    checkCall.disabled = false;
  }

  const canRaise = maxTotal > game.currentBet;
  let minRaiseTotal = game.currentBet + game.minRaise;
  if (minRaiseTotal > maxTotal) minRaiseTotal = maxTotal; // all-in is the only legal raise

  const slider = document.getElementById('raise-slider');
  const numberInput = document.getElementById('raise-input');
  const raiseBtn = document.getElementById('btn-raise');
  const raiseWrap = document.getElementById('raise-area');

  if (canRaise) {
    raiseWrap.style.display = 'flex';
    slider.min = minRaiseTotal;
    slider.max = maxTotal;
    slider.value = minRaiseTotal;
    numberInput.min = minRaiseTotal;
    numberInput.max = maxTotal;
    numberInput.value = minRaiseTotal;
    raiseBtn.disabled = false;
    raiseBtn.textContent = game.currentBet === 0 ? 'Bet' : 'Raise to';
  } else {
    raiseWrap.style.display = 'none';
  }

  const allInBtn = document.getElementById('btn-allin');
  allInBtn.style.display = player.chips > 0 ? 'inline-block' : 'none';
  allInBtn.textContent = `All-In (${maxTotal})`;
}

function hideHumanControls() {
  document.getElementById('controls').style.display = 'none';
}

function readRaiseTotal() {
  const player = game.human;
  const maxTotal = player.chips + player.bet;
  let minRaiseTotal = game.currentBet + game.minRaise;
  if (minRaiseTotal > maxTotal) minRaiseTotal = maxTotal;
  let value = parseInt(document.getElementById('raise-input').value, 10);
  if (isNaN(value)) value = minRaiseTotal;
  value = Math.max(minRaiseTotal, Math.min(maxTotal, value));
  return value;
}

function wireControls() {
  document.getElementById('btn-fold').addEventListener('click', () => {
    submitHumanAction({ action: 'fold' });
  });

  document.getElementById('btn-check-call').addEventListener('click', e => {
    const mode = e.currentTarget.dataset.mode;
    submitHumanAction({ action: mode === 'check' ? 'check' : 'call' });
  });

  document.getElementById('btn-raise').addEventListener('click', () => {
    submitHumanAction({ action: 'raise', amount: readRaiseTotal() });
  });

  document.getElementById('btn-allin').addEventListener('click', () => {
    const player = game.human;
    const maxTotal = player.chips + player.bet;
    if (maxTotal > game.currentBet) {
      submitHumanAction({ action: 'raise', amount: maxTotal });
    } else {
      submitHumanAction({ action: 'call' }); // short all-in call
    }
  });

  const slider = document.getElementById('raise-slider');
  const numberInput = document.getElementById('raise-input');
  slider.addEventListener('input', () => { numberInput.value = slider.value; });
  numberInput.addEventListener('input', () => { slider.value = numberInput.value; });

  document.getElementById('btn-next-hand').addEventListener('click', nextHand);
  document.getElementById('btn-new-game').addEventListener('click', newGame);
}

window.addEventListener('DOMContentLoaded', () => {
  wireControls();
  newGame();
});
