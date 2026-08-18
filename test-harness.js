/*
 * Throwaway correctness harness. Loads the real game scripts with tiny DOM
 * stubs and asserts poker rules + side-pot math. Not part of the game.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const dir = __dirname;
const ctx = {};
ctx.crypto = require('crypto').webcrypto;
ctx.Math = Math;
// Minimal DOM/window stubs so game.js can load without a browser.
const fakeEl = new Proxy({}, {
  get: (t, k) => {
    if (k === 'style') return {};
    if (k === 'dataset') return {};
    if (k === 'classList') return { add() {}, remove() {}, toggle() {} };
    if (k === 'addEventListener') return () => {};
    if (k === 'appendChild' || k === 'removeChild' || k === 'prepend') return () => {};
    if (k === 'children') return [];
    return '';
  },
  set: () => true
});
ctx.document = {
  getElementById: () => fakeEl,
  createElement: () => fakeEl,
  addEventListener: () => {}
};
ctx.window = { addEventListener: () => {} };
ctx.setTimeout = setTimeout;
ctx.console = console;

vm.createContext(ctx);
for (const f of ['deck.js', 'evaluator.js', 'ai.js', 'game.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx);
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL:', name); }
}

const C = (rank, suit) => ({ rank, suit });
const ev = ctx.evaluate7;
const cmp = ctx.compareScores;
const name = ctx.handName;

// --- Hand ranking sanity ---
const royal = ev([C(14,1),C(13,1),C(12,1),C(11,1),C(10,1),C(2,0),C(3,2)]);
check('royal flush named', name(royal) === 'Royal Flush');

const straightFlush = ev([C(9,0),C(8,0),C(7,0),C(6,0),C(5,0),C(2,1),C(3,2)]);
check('SF beats quads', cmp(straightFlush, ev([C(14,0),C(14,1),C(14,2),C(14,3),C(5,0),C(2,1),C(3,2)])) > 0);

const quads = ev([C(14,0),C(14,1),C(14,2),C(14,3),C(5,0),C(2,1),C(3,2)]);
check('quads beat full house', cmp(quads, ev([C(14,0),C(14,1),C(14,2),C(13,0),C(13,1),C(2,1),C(3,2)])) > 0);
check('quads named', name(quads) === 'Four of a Kind');

const fullHouse = ev([C(14,0),C(14,1),C(14,2),C(13,0),C(13,1),C(2,1),C(3,2)]);
check('full house beats flush', cmp(fullHouse, ev([C(14,3),C(11,3),C(9,3),C(6,3),C(2,3),C(3,0),C(4,1)])) > 0);
check('full house named', name(fullHouse) === 'Full House');

const flush = ev([C(14,3),C(11,3),C(9,3),C(6,3),C(2,3),C(3,0),C(4,1)]);
check('flush beats straight', cmp(flush, ev([C(10,0),C(9,1),C(8,2),C(7,3),C(6,0),C(2,1),C(3,2)])) > 0);

// --- Wheel straight (A-2-3-4-5) ---
const wheel = ev([C(14,0),C(2,1),C(3,2),C(4,3),C(5,0),C(13,1),C(11,2)]);
check('wheel is a straight', name(wheel) === 'Straight');
const sixHigh = ev([C(6,0),C(5,1),C(4,2),C(3,3),C(2,0),C(14,1),C(13,2)]);
check('6-high straight beats wheel', cmp(sixHigh, wheel) > 0);

// --- Kickers ---
const pairAcesKingKick = ev([C(14,0),C(14,1),C(13,2),C(9,3),C(4,0),C(2,1),C(3,2)]);
const pairAcesQueenKick = ev([C(14,0),C(14,1),C(12,2),C(9,3),C(4,0),C(2,1),C(3,2)]);
check('pair kicker matters', cmp(pairAcesKingKick, pairAcesQueenKick) > 0);
check('pair named', name(pairAcesKingKick) === 'Pair');

// --- Ties (identical best five from different 7-card sets) ---
const a = ev([C(14,0),C(13,0),C(12,0),C(11,0),C(10,0),C(2,1),C(3,2)]);
const b = ev([C(14,1),C(13,1),C(12,1),C(11,1),C(10,1),C(4,2),C(5,3)]);
check('two royals tie', cmp(a, b) === 0);

// --- Best-of-7 selection ---
const twoPairBest = ev([C(14,0),C(14,1),C(2,2),C(2,3),C(13,0),C(13,1),C(9,2)]);
// Best five here is aces + kings + 9 kicker (two pair), NOT aces+2s.
check('best 7 picks top two pair', name(twoPairBest) === 'Two Pair' && twoPairBest[1] === 14 && twoPairBest[2] === 13);

// --- Side pots ---
// A all-in 100, B all-in 300, C 300, D folds after 40.
// Contributions: A100, B300, C300, D40.
const mkP = (nameStr, committed, folded) => ({ name: nameStr, committed, folded, chips: 0, hole: [] });
ctx.game.players = [
  mkP('A', 100, false),
  mkP('B', 300, false),
  mkP('C', 300, false),
  mkP('D', 40, true)
];
const pots = ctx.buildPots();
// Layer 1: level 40 across all 4 = 160, eligible A,B,C (D folded)
// Layer 2: level 100-40=60 across A,B,C = 180, eligible A,B,C
// Layer 3: level 300-100=200 across B,C = 400, eligible B,C
const total = pots.reduce((s, p) => s + p.amount, 0);
check('side pots total equals contributions', total === 100 + 300 + 300 + 40);
check('three pot layers', pots.length === 3);
check('layer1 amount 160', pots[0].amount === 160);
check('layer1 excludes folded D', !pots[0].eligible.some(p => p.name === 'D'));
check('layer2 amount 180', pots[1].amount === 180);
check('layer3 amount 400 (B,C only)', pots[2].amount === 400 &&
  pots[2].eligible.length === 2 && pots[2].eligible.every(p => p.name === 'B' || p.name === 'C'));

// --- Shuffle produces 52 unique cards ---
const deck = ctx.freshShuffledDeck();
const seen = new Set(deck.map(c => c.rank + '-' + c.suit));
check('deck has 52 unique cards', deck.length === 52 && seen.size === 52);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
