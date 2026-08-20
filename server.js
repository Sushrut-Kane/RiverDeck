/*
 * server.js — a tiny, dependency-free server for online Riverdeck.
 *
 * It does two jobs:
 *   1. Serves the static game (index.html, the .js files, style.css).
 *   2. Exposes a small JSON API for rooms. Rooms live in memory, keyed by the
 *      game code players type in. No database, no auth — exactly as asked. A
 *      room is the "session where the entered codes are saved": share a code,
 *      everyone who types it lands at the same table, and empty seats can be
 *      filled with AI.
 *
 * Realtime updates use long-polling (GET /api/state blocks until something
 * changes), so no WebSocket dependency and it runs anywhere Node runs.
 *
 * Run:  node server.js      then open  http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const engine = require('./engine');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const POLL_TIMEOUT = 25000; // how long a state request may hang before returning

const rooms = new Map();

// ---- Rooms -----------------------------------------------------------------

function getOrCreateRoom(code, opts) {
  const key = normalizeCode(code);
  if (!key) throw new Error('bad_code');
  let room = rooms.get(key);
  if (!room) {
    room = engine.createRoom(key, opts);
    room.onChange = r => flushWaiters(r);
    room.waiters = [];
    rooms.set(key, room);
  }
  return room;
}

function normalizeCode(code) {
  return (code || '').toString().trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 12);
}

function flushWaiters(room) {
  if (!room.waiters || room.waiters.length === 0) return;
  const waiters = room.waiters;
  room.waiters = [];
  for (const w of waiters) {
    clearTimeout(w.timeout);
    sendJSON(w.res, 200, { version: room.version, view: engine.viewFor(room, w.token) });
  }
}

// Drop rooms that have been idle for a long time so memory doesn't grow forever.
function reapRooms() {
  const now = Date.now();
  for (const [key, room] of rooms) {
    const idleMs = now - (room.lastActivity || room.createdAt);
    if (idleMs > 2 * 60 * 60 * 1000) {
      if (room.timer) room.cancel(room.timer);
      if (room.turnTimer) room.cancel(room.turnTimer);
      rooms.delete(key);
    }
  }
}
setInterval(reapRooms, 10 * 60 * 1000).unref();

// ---- HTTP helpers ----------------------------------------------------------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('body_too_large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // Prevent path traversal: resolve and confirm it stays inside ROOT.
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---- API -------------------------------------------------------------------

async function handleApi(req, res, pathname, query) {
  const mark = code => { const r = rooms.get(normalizeCode(code)); if (r) r.lastActivity = Date.now(); };

  if (req.method === 'GET' && pathname === '/api/state') {
    const room = rooms.get(normalizeCode(query.code));
    if (!room) return sendJSON(res, 404, { error: 'no_room' });
    room.lastActivity = Date.now();
    const token = query.token || '';
    const since = Number(query.v) || 0;
    if (room.version > since) {
      return sendJSON(res, 200, { version: room.version, view: engine.viewFor(room, token) });
    }
    const waiter = {
      res, token,
      timeout: setTimeout(() => {
        room.waiters = room.waiters.filter(w => w !== waiter);
        sendJSON(res, 200, { version: room.version, view: engine.viewFor(room, token) });
      }, POLL_TIMEOUT)
    };
    room.waiters.push(waiter);
    req.on('close', () => {
      clearTimeout(waiter.timeout);
      room.waiters = room.waiters.filter(w => w !== waiter);
    });
    return;
  }

  const body = await readBody(req);

  if (req.method === 'POST' && pathname === '/api/join') {
    const room = getOrCreateRoom(body.code, { fillAI: body.fillAI, tableSize: body.tableSize });
    room.lastActivity = Date.now();
    const result = engine.joinRoom(room, body.name, body.token);
    return sendJSON(res, 200, { token: result.token, view: engine.viewFor(room, result.token) });
  }

  if (req.method === 'POST' && pathname === '/api/start') {
    const room = rooms.get(normalizeCode(body.code));
    if (!room) return sendJSON(res, 404, { error: 'no_room' });
    mark(body.code);
    engine.startGame(room, { fillAI: body.fillAI, tableSize: body.tableSize });
    return sendJSON(res, 200, { view: engine.viewFor(room, body.token) });
  }

  if (req.method === 'POST' && pathname === '/api/action') {
    const room = rooms.get(normalizeCode(body.code));
    if (!room) return sendJSON(res, 404, { error: 'no_room' });
    mark(body.code);
    engine.submitAction(room, body.token, { action: body.move, amount: body.amount });
    return sendJSON(res, 200, { view: engine.viewFor(room, body.token) });
  }

  if (req.method === 'POST' && pathname === '/api/next') {
    const room = rooms.get(normalizeCode(body.code));
    if (!room) return sendJSON(res, 404, { error: 'no_room' });
    mark(body.code);
    engine.requestNextHand(room);
    return sendJSON(res, 200, { view: engine.viewFor(room, body.token) });
  }

  sendJSON(res, 404, { error: 'not_found' });
}

// ---- Server ----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.query).catch(err => {
      sendJSON(res, 400, { error: err.message || 'bad_request' });
    });
    return;
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Riverdeck server running at http://localhost:${PORT}`);
});
