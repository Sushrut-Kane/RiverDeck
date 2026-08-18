/*
 * deck.js — cards, a fair 52-card deck, and an unbiased shuffle.
 *
 * Fairness notes (this is the whole point of the game):
 *  - There are exactly 52 unique cards. No duplicates, no jokers, no tricks.
 *  - The shuffle uses Fisher-Yates driven by crypto.getRandomValues with
 *    rejection sampling, so every ordering is equally likely (no modulo bias).
 *  - Cards are dealt once per hand from the top of this shuffled deck and are
 *    never changed, swapped, or peeked at afterwards. What you draw is what
 *    you keep until the hand is over.
 */

// Rank values: 2..10 are literal, 11=J, 12=Q, 13=K, 14=A.
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

// Suit index -> symbol. 0=spades, 1=hearts, 2=diamonds, 3=clubs.
const SUIT_SYMBOLS = ['\u2660', '\u2665', '\u2666', '\u2663'];
const RED_SUITS = new Set([1, 2]);

const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

// Build a fresh, ordered 52-card deck.
function createDeck() {
  const deck = [];
  for (let suit = 0; suit < 4; suit++) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Cryptographically-strong unbiased integer in [0, maxExclusive).
function secureRandomInt(maxExclusive) {
  if (maxExclusive <= 0) return 0;
  const buf = new Uint32Array(1);
  // Largest multiple of maxExclusive that fits in a uint32, used to reject
  // the biased tail so all values are uniformly likely.
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % maxExclusive;
}

// In-place Fisher-Yates shuffle. Returns the same array for convenience.
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

// A freshly shuffled deck, ready to deal from the top (pop()).
function freshShuffledDeck() {
  return shuffle(createDeck());
}

function rankLabel(rank) {
  return RANK_LABELS[rank];
}

function suitSymbol(suit) {
  return SUIT_SYMBOLS[suit];
}

function isRedSuit(suit) {
  return RED_SUITS.has(suit);
}

// Human-readable card, e.g. "A\u2660".
function cardToString(card) {
  return rankLabel(card.rank) + suitSymbol(card.suit);
}
