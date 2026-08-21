/*
 * engine-test.js — headless checks for the multiplayer engine.
 *
 * Uses a manual scheduler (a queue we drain by hand) so entire games play out
 * deterministically and instantly, with no real timers. Asserts the things that
 * must always hold: chips are conserved, pots clear, and a game resolves to a
 * single winner.
 */
const engine = require('./engine');
const shared = require('./shared-node');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.log('FAIL:', name); }
}

// A room whose timers we control: schedule() just queues the callback.
function manualRoom(code, opts) {
  const room = engine.createRoom(code, opts);
  const queue = [];
  room.schedule = fn => { queue.push(fn); return { fn }; };
  room.cancel = handle => {
    const i = queue.findIndex(f => f === (handle && handle.fn));
    if (i >= 0) queue.splice(i, 1);
  };
  room._queue = queue;
  return room;
}

// Drain queued callbacks; auto-answer any human seat so hands complete.
// `humanMove` returns an intent for the seat that is being asked to act.
function run(room, humanMove, cap = 20000) {
  let steps = 0;
  while (steps++ < cap) {
    if (room.awaiting) {
      const seat = room.awaiting.seat;
      const token = room.players[seat].token;
      engine.submitAction(room, token, humanMove(room, seat));
      continue;
    }
    if (room._queue.length === 0) break;
    const fn = room._queue.shift();
    fn();
  }
  return steps;
}

function totalChips(room) {
  return room.players.reduce((s, p) => s + p.chips, 0) + room.pot;
}

// --- Two humans + AI fill, everyone always calls/checks --------------------
{
  const room = manualRoom('TEST1', { fillAI: true, tableSize: 6 });
  const a = engine.joinRoom(room, 'Alice');
  const b = engine.joinRoom(room, 'Bob');
  check('join returns tokens', !!a.token && !!b.token && a.token !== b.token);
  check('lobby has two humans', room.humans.length === 2);

  engine.startGame(room, { fillAI: true, tableSize: 6 });
  check('game seats six', room.players.length === 6);
  check('two human seats', room.players.filter(p => p.kind === 'human').length === 2);
  check('four ai seats', room.players.filter(p => p.kind === 'ai').length === 4);

  const startTotal = totalChips(room);
  check('start bank is 6000', startTotal === 6000);

  const passiveMove = (r) => {
    const seat = r.awaiting.seat;
    const p = r.players[seat];
    return { action: (r.currentBet - p.bet) > 0 ? 'call' : 'check' };
  };

  // Play until the game ends, checking the bank stays constant at every rest.
  let guard = 0;
  while (room.phase !== 'gameover' && guard++ < 400) {
    run(room, passiveMove, 5000);
    check('bank conserved: ' + room.handNumber, totalChips(room) === startTotal);
    check('pot cleared at rest', room.pot === 0);
    if (room.phase === 'handover') engine.requestNextHand(room);
  }
  check('reaches a single winner', room.phase === 'gameover');
  check('winner holds the whole bank', room.players.some(p => p.chips === startTotal));
  check('played multiple hands', room.handNumber > 1);
}

// --- Heads-up: only one human, filled to two with AI -----------------------
{
  const room = manualRoom('HU', { fillAI: true, tableSize: 2 });
  engine.joinRoom(room, 'Solo');
  engine.startGame(room, { fillAI: true, tableSize: 2 });
  check('heads-up seats two', room.players.length === 2);
  const startTotal = totalChips(room);

  const shoveMove = (r) => {
    const seat = r.awaiting.seat;
    const p = r.players[seat];
    return { action: 'allin' }; // stress side-pot / all-in paths
  };
  let guard = 0;
  while (room.phase !== 'gameover' && guard++ < 400) {
    run(room, shoveMove, 5000);
    check('heads-up bank conserved', totalChips(room) === startTotal);
    if (room.phase === 'handover') engine.requestNextHand(room);
  }
  check('heads-up resolves', room.phase === 'gameover');
}

// --- View hides other players' hole cards ----------------------------------
{
  const room = manualRoom('SECRET', { fillAI: true, tableSize: 3 });
  const me = engine.joinRoom(room, 'Me');
  engine.joinRoom(room, 'You');
  engine.startGame(room, { fillAI: true, tableSize: 3 });
  const view = engine.viewFor(room, me.token);
  const myCards = view.players[view.you].hole;
  check('I can see my own cards', Array.isArray(myCards) && myCards.length === 2);
  const others = view.players.filter(p => !p.isYou);
  check('others hidden pre-showdown', others.every(p => p.hole === null));
}

// --- Draw reading & scare cards (deterministic helpers) --------------------
{
  const C = (rank, suit) => ({ rank, suit });
  // 4 to a flush (A9 of hearts + two more hearts) is a strong draw.
  check('flush draw is strong', shared.drawStrength([C(14, 1), C(9, 1)], [C(5, 1), C(2, 1), C(13, 0)]) >= 0.8);
  // 6-7-8-9 is open-ended.
  check('open-ender is strong', shared.drawStrength([C(9, 0), C(8, 1)], [C(7, 2), C(6, 3), C(2, 0)]) >= 0.75);
  // 5-6-7 + 9 needs an 8 (inside draw).
  const gut = shared.drawStrength([C(9, 0), C(5, 1)], [C(7, 2), C(6, 3), C(2, 0)]);
  check('gutshot is a weak draw', gut > 0 && gut < 0.6);
  check('no draw scores zero', shared.drawStrength([C(14, 0), C(9, 1)], [C(2, 2), C(7, 3), C(13, 0)]) === 0);
  // A completed flush is not a draw.
  check('made flush is not a draw', shared.drawStrength([C(14, 1), C(9, 1)], [C(5, 1), C(2, 1), C(13, 1)]) === 0);
  // River (5 cards) has no draws.
  check('no draws on the river', shared.drawStrength([C(14, 1), C(9, 1)], [C(5, 1), C(2, 1), C(13, 0), C(3, 2), C(4, 2)]) === 0);

  check('an ace on the turn is scary', shared.scaryBoardCard([C(9, 0), C(6, 1), C(4, 2), C(14, 3)]) === true);
  check('a third flush card is scary', shared.scaryBoardCard([C(9, 0), C(6, 0), C(4, 2), C(2, 0)]) === true);
  check('a low blank turn is calm', shared.scaryBoardCard([C(11, 0), C(9, 1), C(4, 2), C(2, 3)]) === false);
}

// --- Short-stack push/fold --------------------------------------------------
{
  const C = (rank, suit) => ({ rank, suit });
  const mkSeat = (id, over) => Object.assign({
    id, name: 'P' + id, chips: 1000, bet: 0, hole: [], folded: false, out: false,
    personality: shared.makePersonality(id),
    tendencies: { aggressiveAlpha: 1, aggressiveBeta: 3, continueAlpha: 1, continueBeta: 1 }
  }, over || {});

  // 8bb with pocket aces: jam all-in, never a thin min-raise, never fold.
  let sawShove = false, partialRaise = false, folded = false;
  for (let i = 0; i < 60; i++) {
    const hero = mkSeat(0, { chips: 160, hole: [C(14, 0), C(14, 1)] });
    const villain = mkSeat(1, { chips: 1000, bet: 20, hole: [] });
    const game = {
      players: [hero, villain], community: [], stage: 'Pre-Flop',
      currentBet: 20, pot: 30, bigBlind: 20, minRaise: 20,
      seatOrder: [0, 1], bbIndex: 0, dealerIndex: 1, handActions: []
    };
    const d = shared.decideAction(hero, game);
    if (d.action === 'raise') { if (d.amount === hero.chips + hero.bet) sawShove = true; else partialRaise = true; }
    if (d.action === 'fold') folded = true;
  }
  check('short stack jams aces all-in', sawShove);
  check('short stack never min-raises', !partialRaise);
  check('short stack never folds aces', !folded);

  // 7bb with 7-2 offsuit vs a big bet on A-J-6: fold, and never jam trash.
  let foldedWeak = 0, jammedWeak = 0;
  for (let i = 0; i < 40; i++) {
    const hero = mkSeat(0, { chips: 140, hole: [C(7, 3), C(2, 0)] });
    const villain = mkSeat(1, { chips: 1000, bet: 120, hole: [] });
    const game = {
      players: [hero, villain], community: [C(14, 0), C(11, 1), C(6, 2)], stage: 'Flop',
      currentBet: 120, pot: 180, bigBlind: 20, minRaise: 20,
      seatOrder: [0, 1], bbIndex: 0, dealerIndex: 1, handActions: []
    };
    const d = shared.decideAction(hero, game);
    if (d.action === 'fold') foldedWeak++;
    if (d.action === 'raise') jammedWeak++;
  }
  check('short stack folds trash to a big bet', foldedWeak >= 30);
  check('short stack does not jam trash', jammedWeak === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
