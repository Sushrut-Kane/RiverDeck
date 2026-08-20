/*
 * engine-test.js — headless checks for the multiplayer engine.
 *
 * Uses a manual scheduler (a queue we drain by hand) so entire games play out
 * deterministically and instantly, with no real timers. Asserts the things that
 * must always hold: chips are conserved, pots clear, and a game resolves to a
 * single winner.
 */
const engine = require('./engine');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
