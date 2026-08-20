/*
 * ai.js — honest opponents.
 *
 * Every AI decides using ONLY its own two hole cards plus the shared
 * community cards. It never sees your cards, never sees the deck, and never
 * gets a nudge to win or lose. Decisions come from hand strength, pot odds,
 * and a fixed per-player personality (so opponents feel distinct but fair).
 *
 * It also READS the table: without ever seeing a card, it weights each
 * opponent's likely holdings by how they've been betting this hand, so a
 * player who keeps calling or (especially) raising is treated as probably
 * stronger — exactly the read a human makes from money going in.
 */

const AI_ARCHETYPES = [
  { label: 'Tight-aggressive', aggression: 1.15, bluff: 0.05, looseness: 0.88, slowPlay: 0.08, cBet: 0.66 },
  { label: 'Loose-aggressive', aggression: 1.3, bluff: 0.14, looseness: 1.12, slowPlay: 0.04, cBet: 0.72 },
  { label: 'Calling station', aggression: 0.72, bluff: 0.025, looseness: 1.24, slowPlay: 0.03, cBet: 0.35 },
  { label: 'Maniac', aggression: 1.42, bluff: 0.2, looseness: 1.08, slowPlay: 0.02, cBet: 0.8 },
  { label: 'Tricky regular', aggression: 1.02, bluff: 0.09, looseness: 0.98, slowPlay: 0.18, cBet: 0.58 }
];

function makePersonality(seat) {
  const index = Number.isInteger(seat) ? Math.max(0, seat - 1) : 0;
  return { ...AI_ARCHETYPES[index % AI_ARCHETYPES.length] };
}

// The 52-card deck minus a set of known cards (our hole + the visible board).
// Encodes each card as rank*4+suit so we can exclude by identity.
function remainingDeck(known) {
  const used = new Set(known.map(c => c.rank * 4 + c.suit));
  const deck = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      const id = rank * 4 + suit;
      if (!used.has(id)) deck.push({ rank, suit });
    }
  }
  return deck;
}

// Fast in-place shuffle for sampling (the real deal still uses the crypto
// shuffle in deck.js — this only drives the AI's private "what if" rollouts).
function sampleShuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// A quick read of how strong a pair of hole cards looks ON THE CURRENTLY
// VISIBLE board — used only to weight an opponent's likely holdings, never to
// peek. Pre-flop it's a light high-card/pair/suited/connected heuristic;
// post-flop it's the made-hand category they'd have on the shared board.
function perceivedStrength(hole, community) {
  if (community.length === 0) {
    const hi = Math.max(hole[0].rank, hole[1].rank);
    const lo = Math.min(hole[0].rank, hole[1].rank);
    const suited = hole[0].suit === hole[1].suit;
    let s = ((hi - 2) / 12) * 0.5 + ((lo - 2) / 12) * 0.22;
    if (hi === lo) s += 0.34;                                 // pocket pair
    if (suited) s += 0.06;
    const gap = hi - lo;
    if (hi !== lo && gap <= 2) s += 0.06 - (gap - 1) * 0.02;  // connectivity
    return Math.max(0.02, Math.min(0.99, s));
  }
  const score = evaluate7([...hole, ...community]);
  const base = [0, 0.08, 0.26, 0.42, 0.55, 0.66, 0.76, 0.86, 0.94, 0.99][score[0]];
  const kicker = ((score[1] || 0) / 14) * 0.05;
  return Math.min(0.99, base + kicker);
}

const WEIGHT_EPS = 0.025;

function actionHistoryFor(player, game) {
  return (game.handActions || []).filter(entry => entry.playerId === player.id);
}

function betaMean(alpha, beta, prior) {
  const a = Number.isFinite(alpha) ? alpha : prior[0];
  const b = Number.isFinite(beta) ? beta : prior[1];
  return a / (a + b);
}

function publicProfile(opponent) {
  const tendency = opponent.tendencies || {};
  const aggression = betaMean(tendency.aggressiveAlpha, tendency.aggressiveBeta, [1, 3]);
  const continuation = betaMean(tendency.continueAlpha, tendency.continueBeta, [1, 1]);
  return {
    aggression,
    bluff: 0.025 + aggression * 0.14,
    looseness: 0.8 + continuation * 0.42,
    slowPlay: 0.05 + Math.max(0, aggression - 0.3) * 0.12
  };
}

function rangeLikelihood(strength, action, profile) {
  const signal = action.board && action.board.length > 0 ? Math.min(1, strength * 2.4) : strength;
  if (action.action === 'fold') return 1;
  if (action.action === 'check') {
    return 0.62 + 0.3 * (1 - signal) + profile.slowPlay * signal;
  }

  const size = Math.max(0, action.size || 0);
  if (action.action === 'call') {
    const callPressure = 0.35 + Math.min(1.1, size * 0.65);
    const looseFloor = 0.12 + (profile.looseness - 0.8) * 0.22;
    return looseFloor + (1 - looseFloor) * Math.pow(signal, callPressure);
  }

  let exponent;
  if (size < 0.34) exponent = 0.55;       // probe bet: a deliberately wide range
  else if (size < 0.7) exponent = 0.95;   // half-pot pressure: normal range
  else if (size <= 1.08) exponent = 1.4;  // pot bet: stronger or bluff-polarized
  else exponent = 1.75;                   // overbet: highly polarized
  if (action.isReraise) exponent += 2.1;

  const valueLikelihood = Math.pow(signal, exponent);
  const polarized = size >= 0.9 ? 1.35 : 0.85;
  const bluffChance = Math.min(0.32, profile.bluff * polarized * (action.isReraise ? 0.45 : 1));
  const bluffLikelihood = 0.08 + 0.92 * Math.pow(1 - signal, 0.75);
  return (1 - bluffChance) * valueLikelihood + bluffChance * bluffLikelihood;
}

function rangeWeight(hole, opponent, game) {
  let weight = 1;
  const profile = publicProfile(opponent);
  for (const action of actionHistoryFor(opponent, game)) {
    if (action.action === 'fold') continue;
    const strength = perceivedStrength(hole, action.board || []);
    weight *= Math.max(WEIGHT_EPS, rangeLikelihood(strength, action, profile));
  }
  return weight;
}

// Builds all currently possible two-card combinations and weights them from
// public betting evidence. The simulator uses the same weights while sampling.
function buildOpponentRange(opponent, game, knownCards) {
  const deck = remainingDeck(knownCards);
  const combos = [];
  let total = 0;
  let weightedStrength = 0;
  for (let i = 0; i < deck.length - 1; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const hole = [deck[i], deck[j]];
      const weight = rangeWeight(hole, opponent, game);
      const strength = perceivedStrength(hole, game.community);
      combos.push({ hole, weight });
      total += weight;
      weightedStrength += weight * strength;
    }
  }
  const meanStrength = total ? weightedStrength / total : 0;
  const actions = actionHistoryFor(opponent, game).filter(action => action.action !== 'check');
  const largeReraise = actions.some(action => action.isReraise && action.size >= 0.9);
  const label = actions.length === 0 ? 'unread' : largeReraise ? 'polarized / very strong' :
    meanStrength < 0.205 ? 'wide' : meanStrength < 0.225 ? 'medium' :
    meanStrength < 0.25 ? 'strong' : 'very strong';
  return { combos, total, meanStrength, label };
}

function estimateEquity(hole, community, opponents, iterations) {
  if (opponents.length <= 0) return 1;
  const known = [...hole, ...community];
  let wWin = 0;
  let wTotal = 0;

  for (let it = 0; it < iterations; it++) {
    const deck = sampleShuffle(remainingDeck(known));
    let d = 0;
    const board = community.slice();
    while (board.length < 5) board.push(deck[d++]);

    const mine = evaluate7([...hole, ...board]);
    let iAmBest = true;
    let tiedWith = 1;
    let weight = 1;

    for (const opponent of opponents) {
      const candidate = [deck[d++], deck[d++]];
      const cmp = compareScores(mine, evaluate7([...candidate, ...board]));
      if (cmp < 0) iAmBest = false;
      else if (cmp === 0) tiedWith++;
      if (typeof opponent === 'number') {
        weight *= Math.pow(perceivedStrength(candidate, community) + WEIGHT_EPS, opponent);
      } else {
        weight *= rangeWeight(candidate, opponent.opponent, opponent.game);
      }
    }

    wTotal += weight;
    if (iAmBest) wWin += weight / tiedWith;
  }
  return wTotal > 0 ? wWin / wTotal : 0;
}

// Opponents still contesting the pot (folded/out players cannot win it, but
// all-in players still can, so they count toward what we must beat).
function liveOpponents(player, game) {
  return game.players.filter(
    q => q !== player && !q.folded && !q.out
  ).length;
}

// This hand's honest win-share right now: its own cards, read against how the
// live opponents have actually been betting this hand.
function handAnalysis(player, game) {
  const opponents = game.players.filter(q => q !== player && !q.folded && !q.out);
  if (opponents.length === 0) return { equity: 1, ranges: [] };
  const known = [...player.hole, ...game.community];
  const ranges = opponents.map(opponent => ({
    opponent,
    range: buildOpponentRange(opponent, game, known),
    game
  }));
  const base = game.community.length === 0 ? 260 : 320;
  return {
    equity: estimateEquity(player.hole, game.community, ranges, base),
    ranges
  };
}

function handStrength(player, game) {
  return handAnalysis(player, game).equity;
}

function positionEdge(player, game) {
  const order = game.seatOrder || game.players.map(p => p.id);
  const playerPos = order.indexOf(player.id);
  const lastToAct = game.stage === 'Pre-Flop' ? game.bbIndex : game.dealerIndex;
  const lastPos = order.indexOf(lastToAct);
  if (playerPos < 0 || lastPos < 0) return 0;
  const distance = (lastPos - playerPos + order.length) % order.length;
  if (distance === 0) return 0.07;
  if (distance === 1) return 0.035;
  return -0.045 * (1 - distance / order.length);
}

function streetAggression(game, street) {
  return (game.handActions || []).filter(entry =>
    entry.street === street && (entry.action === 'bet' || entry.action === 'raise')
  );
}

function wasPreflopAggressor(player, game) {
  return streetAggression(game, 'Pre-Flop').some(entry => entry.playerId === player.id);
}

function decision(action, details) {
  return { action, ...details };
}

/*
 * Decide an action for an AI player.
 * Returns one of:
 *   { action: 'fold' }
 *   { action: 'check' }
 *   { action: 'call' }
 *   { action: 'raise', amount: <total chips this player will have wagered this round> }
 */
function decideAction(player, game) {
  const p = player.personality;
  const toCall = game.currentBet - player.bet;
  const pot = game.pot;
  const bigBlind = game.bigBlind;
  const analysis = handAnalysis(player, game);
  const equity = analysis.equity;
  const opponents = Math.max(1, liveOpponents(player, game));
  const position = positionEdge(player, game);
  const inPosition = position > 0;
  const rangeText = analysis.ranges.map(entry =>
    `${entry.opponent.name}: ${entry.range.label}`
  ).join(', ');
  const meta = { equity, ranges: rangeText, position };
  const wantToValueBet = 0.5 + 0.04 * opponents - position * 0.3;
  const roll = Math.random();

  const sizedRaiseTo = (fraction, bluff) => {
    const maxTotal = player.chips + player.bet; // going all-in caps the raise
    const preflopRaises = streetAggression(game, 'Pre-Flop');
    let target;
    if (game.stage === 'Pre-Flop') {
      if (preflopRaises.length === 0) {
        target = Math.round(bigBlind * (2.2 + 0.8 * p.aggression));
      } else {
        const multiplier = inPosition ? 3 : 4;
        target = Math.round(game.currentBet * multiplier);
      }
    } else {
      const choices = bluff ? [0.33, 0.5, 0.75] : [0.5, 0.75, 1, 1.25];
      const desired = choices.reduce((best, size) =>
        Math.abs(size - fraction) < Math.abs(best - fraction) ? size : best
      );
      target = game.currentBet + Math.round(pot * desired * p.aggression);
    }
    target = Math.max(game.currentBet + game.minRaise, target);
    return Math.min(target, maxTotal);
  };

  if (toCall === 0) {
    const valueBet = equity > wantToValueBet;
    const cBet = game.stage === 'Flop' && inPosition && wasPreflopAggressor(player, game) &&
      equity > 0.2 && roll < p.cBet * 0.25;
    const bluff = roll < p.bluff && equity > 0.2;
    const slowPlay = game.community.length > 0 && equity > 0.8 && roll < p.slowPlay;
    const checkBack = inPosition && equity >= 0.42 && equity <= 0.62 && roll < 0.34;
    if ((valueBet || bluff || cBet) && !slowPlay && !checkBack && player.chips > 0) {
      const frac = equity > 0.86 ? 1 : equity > 0.7 ? 0.75 : 0.5;
      const raiseTo = sizedRaiseTo(frac, bluff || cBet);
      if (raiseTo > game.currentBet) {
        const reason = valueBet ? 'value bet' : cBet ? 'position c-bet' : 'bluff';
        return decision('raise', { amount: raiseTo, reason, ...meta });
      }
    }
    const reason = slowPlay ? 'slow-play' : checkBack ? 'showdown-value check' : 'no profitable bet';
    return decision('check', { reason, ...meta });
  }

  const potOdds = toCall / (pot + toCall);

  if (equity > 0.66 + 0.03 * opponents - position * 0.2 &&
      player.chips > toCall &&
      roll < 0.3 + 0.5 * p.aggression) {
    const raiseTo = sizedRaiseTo(equity > 0.85 ? 1 : 0.75, false);
    if (raiseTo >= game.currentBet + game.minRaise) {
      return decision('raise', { amount: raiseTo, potOdds, reason: 'value raise', ...meta });
    }
  }

  if (roll < p.bluff * 0.5 && player.chips > toCall) {
    const raiseTo = sizedRaiseTo(0.5, true);
    if (raiseTo >= game.currentBet + game.minRaise) {
      return decision('raise', { amount: raiseTo, potOdds, reason: 'bluff raise', ...meta });
    }
  }

  const slack = (p.looseness - 1) * 0.06 + position * 0.12;
  if (equity + slack >= potOdds) {
    return decision('call', { potOdds, reason: 'equity beats price', ...meta });
  }

  if (toCall <= bigBlind && equity > 0.18 && roll < 0.5) {
    return decision('call', { potOdds, reason: 'cheap price', ...meta });
  }

  return decision('fold', { potOdds, reason: 'equity below price', ...meta });
}
