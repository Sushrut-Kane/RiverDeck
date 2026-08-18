/*
 * ai.js — honest opponents.
 *
 * Every AI decides using ONLY its own two hole cards plus the shared
 * community cards. It never sees your cards, never sees the deck, and never
 * gets a nudge to win or lose. Decisions come from hand strength, pot odds,
 * and a fixed per-player personality (so opponents feel distinct but fair).
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

/*
 * Monte-Carlo equity: the share of the pot this exact two-card hand expects to
 * win at showdown against `opponents` unknown hands. We repeatedly deal random
 * opponent hole cards and complete the board from the unseen deck, score every
 * hand with the real evaluator, and average the results (a tie splits the win).
 *
 * This is what makes an opponent's decision depend on ITS actual cards: a real
 * pair of aces returns ~0.8 heads-up, while 7-2 offsuit returns ~0.35, and a
 * pair that only exists on the shared board scores low because every opponent
 * shares it too.
 */
function estimateEquity(hole, community, opponents, iterations) {
  if (opponents <= 0) return 1;
  const known = [...hole, ...community];
  let total = 0;

  for (let it = 0; it < iterations; it++) {
    const deck = sampleShuffle(remainingDeck(known));
    let d = 0;

    // Complete the shared board to five cards.
    const board = community.slice();
    while (board.length < 5) board.push(deck[d++]);

    const mine = evaluate7([...hole, ...board]);
    let iAmBest = true;
    let tiedWith = 1; // count myself; a tie splits the pot among all tied hands

    for (let o = 0; o < opponents; o++) {
      const opp = evaluate7([deck[d++], deck[d++], ...board]);
      const cmp = compareScores(mine, opp);
      if (cmp < 0) { iAmBest = false; break; }
      if (cmp === 0) tiedWith++;
    }

    if (iAmBest) total += 1 / tiedWith;
  }
  return total / iterations;
}

// Opponents still contesting the pot (folded/out players cannot win it, but
// all-in players still can, so they count toward what we must beat).
function liveOpponents(player, game) {
  return game.players.filter(
    q => q !== player && !q.folded && !q.out
  ).length;
}

// This hand's honest win-share right now, from its own cards only.
function handStrength(player, game) {
  const opponents = Math.max(1, liveOpponents(player, game));
  const iterations = game.community.length === 0 ? 200 : 260;
  return estimateEquity(player.hole, game.community, opponents, iterations);
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
