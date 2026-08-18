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

// Give each seat a stable personality for the whole game. Purely cosmetic to
// how it plays — it does not affect the cards anyone is dealt.
function makePersonality() {
  return {
    // >1 raises/bets more, <1 is more passive.
    aggression: 0.8 + Math.random() * 0.6,
    // Chance to bluff a weak hand or fire on a scary board.
    bluff: 0.04 + Math.random() * 0.12,
    // How willing to call marginal spots (loose vs tight).
    looseness: 0.85 + Math.random() * 0.4
  };
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

// Turn an opponent's betting THIS HAND into a "range tightening" exponent.
// 0 means no read (their hand is treated as random). Raising is strong
// evidence of strength; repeated calling is mild evidence. This is the honest,
// real-life tell: chips in the pot, without ever seeing a card.
function readAggression(opp) {
  const raises = opp.raises || 0;
  const calls = opp.calls || 0;
  return Math.max(0, Math.min(3.5, 1.3 * raises + 0.32 * calls));
}

// Keeps a world's weight from collapsing to exactly zero on a whiffed hand.
const WEIGHT_EPS = 0.03;

/*
 * Monte-Carlo equity with opponent reading.
 *
 * We repeatedly deal random hole cards to each opponent, complete the board
 * from the unseen deck, and score everything with the real evaluator. Each
 * simulated world is then WEIGHTED by how well it matches the opponents'
 * observed betting: a world in which an opponent who has been raising turns out
 * to hold junk is unlikely, so it counts for less (likelihood weighting).
 *
 * `oppAggros[o]` is opponent o's tightening exponent from readAggression():
 *   0      -> that opponent is treated as a uniformly random hand
 *   higher -> their range is pulled toward hands that are strong on the visible
 *             board, so our equity reflects the danger their betting shows.
 *
 * With every exponent 0 this reduces exactly to plain all-random equity, so a
 * table of passive checkers behaves just like before.
 */
function estimateEquity(hole, community, oppAggros, iterations) {
  const opponents = oppAggros.length;
  if (opponents <= 0) return 1;
  const known = [...hole, ...community];
  let wWin = 0;
  let wTotal = 0;

  for (let it = 0; it < iterations; it++) {
    const deck = sampleShuffle(remainingDeck(known));
    let d = 0;

    // Complete the shared board to five cards.
    const board = community.slice();
    while (board.length < 5) board.push(deck[d++]);

    const mine = evaluate7([...hole, ...board]);
    let iAmBest = true;
    let tiedWith = 1; // count myself; a tie splits the pot among all tied hands
    let weight = 1;   // how likely this world is, given the betting we've seen

    for (let o = 0; o < opponents; o++) {
      const c1 = deck[d++];
      const c2 = deck[d++];
      const cmp = compareScores(mine, evaluate7([c1, c2, ...board]));
      if (cmp < 0) iAmBest = false;
      else if (cmp === 0) tiedWith++;

      const a = oppAggros[o];
      if (a > 0) {
        // Down-weight worlds where an aggressive opponent holds a weak hand.
        weight *= Math.pow(perceivedStrength([c1, c2], community) + WEIGHT_EPS, a);
      }
    }

    wTotal += weight;
    if (iAmBest) wWin += weight * (1 / tiedWith);
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
function handStrength(player, game) {
  const opps = game.players.filter(q => q !== player && !q.folded && !q.out);
  if (opps.length === 0) return 1;
  const oppAggros = opps.map(readAggression);
  const maxA = oppAggros.reduce((m, a) => Math.max(m, a), 0);
  // A little extra sampling when reads are strong (weighting adds variance).
  const base = game.community.length === 0 ? 240 : 300;
  const iterations = Math.round(base + 30 * maxA);
  return estimateEquity(player.hole, game.community, oppAggros, iterations);
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

  // Honest, card-derived win-share for this exact hand right now.
  const equity = handStrength(player, game);
  const opponents = Math.max(1, liveOpponents(player, game));

  // Fewer opponents -> the same cards are worth pressing harder.
  const wantToValueBet = 0.5 + 0.04 * opponents; // higher bar into more players
  const roll = Math.random();

  // Size a raise as a fraction of the pot, clamped to legal/all-in bounds.
  const sizedRaiseTo = fraction => {
    const target = game.currentBet + Math.max(
      game.minRaise,
      Math.round(pot * fraction * p.aggression)
    );
    const maxTotal = player.chips + player.bet; // going all-in caps the raise
    return Math.min(target, maxTotal);
  };

  // ---- No bet to us: check or bet for value/bluff. ----
  if (toCall === 0) {
    const valueBet = equity > wantToValueBet;
    const bluff = roll < p.bluff && equity > 0.2;
    if ((valueBet || bluff) && player.chips > 0) {
      const frac = equity > 0.8 ? 0.75 : 0.5;
      const raiseTo = sizedRaiseTo(frac);
      if (raiseTo > game.currentBet) return { action: 'raise', amount: raiseTo };
    }
    return { action: 'check' };
  }

  // ---- Facing a bet: the price we must pay to keep playing. ----
  const potOdds = toCall / (pot + toCall); // win-share needed to break even

  // Strong hands re-raise for value; the threshold rises with more opponents.
  if (equity > 0.66 + 0.03 * opponents &&
      player.chips > toCall &&
      roll < 0.3 + 0.5 * p.aggression) {
    const raiseTo = sizedRaiseTo(0.8);
    if (raiseTo >= game.currentBet + game.minRaise) {
      return { action: 'raise', amount: raiseTo };
    }
  }

  // Occasional bluff-raise, kept rare so play stays honest to the cards.
  if (roll < p.bluff * 0.5 && player.chips > toCall) {
    const raiseTo = sizedRaiseTo(0.6);
    if (raiseTo >= game.currentBet + game.minRaise) {
      return { action: 'raise', amount: raiseTo };
    }
  }

  // Core decision: call when our equity beats the pot odds we're offered.
  // Looser personalities give themselves a little extra slack, tighter ones less.
  const slack = (p.looseness - 1) * 0.06;
  if (equity + slack >= potOdds) {
    return { action: 'call' };
  }

  // Very cheap calls with a live hand get a bit of slack (set-mining etc.).
  if (toCall <= bigBlind && equity > 0.18 && roll < 0.5) {
    return { action: 'call' };
  }

  return { action: 'fold' };
}
