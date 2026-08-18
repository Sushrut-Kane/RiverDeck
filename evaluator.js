/*
 * evaluator.js — real poker hand ranking.
 *
 * evaluate5(cards)  -> score array for exactly 5 cards.
 * evaluate7(cards)  -> best score over all 21 five-card subsets of 7 cards.
 *
 * A "score" is an array: [category, tiebreak1, tiebreak2, ...].
 * Higher category wins. Within a category, compare tiebreakers left to right.
 * This models every real poker rule including kickers, split-pot ties, and
 * the Ace-low "wheel" straight (A-2-3-4-5).
 *
 * Categories (high to low):
 *   9 Straight flush   8 Four of a kind   7 Full house
 *   6 Flush            5 Straight         4 Three of a kind
 *   3 Two pair         2 One pair         1 High card
 */

const CATEGORY_NAMES = {
  9: 'Straight Flush',
  8: 'Four of a Kind',
  7: 'Full House',
  6: 'Flush',
  5: 'Straight',
  4: 'Three of a Kind',
  3: 'Two Pair',
  2: 'Pair',
  1: 'High Card'
};

// Evaluate exactly five cards into a comparable score array.
function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // Count how many of each rank we hold.
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;

  // Group as [count, rank], sorted by count then rank (both descending).
  // This ordering is exactly the kicker order for pairs/trips/quads/etc.
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, Number(r)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const ranksByGroup = groups.map(g => g[1]);

  // Straight detection (needs 5 distinct ranks).
  let isStraight = false;
  let straightHigh = 0;
  if (ranksByGroup.length === 5) {
    if (ranks[0] - ranks[4] === 4) {
      isStraight = true;
      straightHigh = ranks[0];
    } else if (ranks[0] === 14 && ranks[1] === 5) {
      // Wheel: A,5,4,3,2 -> the Ace plays low, so the high card is 5.
      isStraight = true;
      straightHigh = 5;
    }
  }

  if (isStraight && isFlush) return [9, straightHigh];
  if (groups[0][0] === 4) return [8, ...ranksByGroup];              // quads + kicker
  if (groups[0][0] === 3 && groups[1][0] === 2) return [7, ...ranksByGroup]; // trips + pair
  if (isFlush) return [6, ...ranks];                                // five flush cards
  if (isStraight) return [5, straightHigh];
  if (groups[0][0] === 3) return [4, ...ranksByGroup];              // trips + 2 kickers
  if (groups[0][0] === 2 && groups[1][0] === 2) return [3, ...ranksByGroup]; // 2 pair + kicker
  if (groups[0][0] === 2) return [2, ...ranksByGroup];              // pair + 3 kickers
  return [1, ...ranks];                                             // high card
}

// Compare two score arrays. >0 if a beats b, <0 if b beats a, 0 if tied.
function compareScores(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Best 5-card hand from 5, 6, or 7 cards (choose the strongest subset).
function evaluateBest(cards) {
  if (cards.length === 5) return evaluate5(cards);
  let best = null;
  // Enumerate all 5-card subsets by choosing which cards to drop.
  const n = cards.length;
  const drop = n - 5;
  if (drop === 1) {
    for (let i = 0; i < n; i++) {
      const five = cards.filter((_, idx) => idx !== i);
      const score = evaluate5(five);
      if (!best || compareScores(score, best) > 0) best = score;
    }
  } else {
    // drop === 2 (the 7-card case): drop every pair of cards.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const five = cards.filter((_, idx) => idx !== i && idx !== j);
        const score = evaluate5(five);
        if (!best || compareScores(score, best) > 0) best = score;
      }
    }
  }
  return best;
}

// Convenience alias used around the game for the 2 hole + up to 5 board cards.
function evaluate7(cards) {
  return evaluateBest(cards);
}

// Friendly name for a score, e.g. "Full House" or "Royal Flush".
function handName(score) {
  if (!score) return '';
  if (score[0] === 9 && score[1] === 14) return 'Royal Flush';
  return CATEGORY_NAMES[score[0]] || '';
}
