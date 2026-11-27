// Servidor mínimo sin dependencias: sirve la web y sincroniza las salas (SSE + fetch).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const rooms = new Map();

const newCode = () => {
  let c;
  do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join('');
  while (rooms.has(c));
  return c;
};

const newRoom = () => ({
  board: Array(9).fill(null), turn: 'X', starter: 'X', winner: null, line: null,
  players: { X: null, O: null }, scores: { X: 0, O: 0, draw: 0 }, chat: [], clients: new Set(), empty: 0,
});

const isOnline = (r, mark) => [...r.clients].some(c => c.mark === mark);

const state = r => ({
  board: r.board, turn: r.turn, winner: r.winner, line: r.line, scores: r.scores,
  players: Object.fromEntries(['X', 'O'].map(m => [m, r.players[m] && { name: r.players[m].name, online: isOnline(r, m) }])),
});

const send = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (r, ev, data) => r.clients.forEach(c => send(c.res, ev, data));
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function auth(body) {
  const r = rooms.get(String(body.room || '').toUpperCase());
  if (!r) return {};
  const mark = ['X', 'O'].find(m => r.players[m] && r.players[m].id === body.id);
  return { r, mark };
}

const actions = {
  create(b) {
    const room = newCode(), id = crypto.randomUUID(), r = newRoom();
    r.players.X = { id, name: clean(b.name, 20) || 'Equipo X' };
    rooms.set(room, r);
    return { room, id, mark: 'X' };
  },
  join(b) {
    const room = String(b.room || '').toUpperCase().trim(), r = rooms.get(room);
    if (!r) throw 'Esa sala no existe';
    if (r.players.O && isOnline(r, 'O')) throw 'La sala está llena';
    const id = crypto.randomUUID();
    r.players.O = { id, name: clean(b.name, 20) || 'Equipo O' };
    broadcast(r, 'state', state(r));
    return { room, id, mark: 'O' };
  },
  check(b) {
    const { r, mark } = auth(b);
    if (!mark) throw 'Sesión caducada';
    return { mark };
  },
  move(b) {
    const { r, mark } = auth(b), i = b.cell | 0;
    if (!mark || !r.players.O || r.winner || r.turn !== mark || i < 0 || i > 8 || r.board[i]) throw 'Movimiento no válido';
    r.board[i] = mark;
    const line = LINES.find(l => l.every(k => r.board[k] === mark));
    if (line) { r.winner = mark; r.line = line; r.scores[mark]++; }
    else if (r.board.every(Boolean)) { r.winner = 'draw'; r.scores.draw++; }
    else r.turn = mark === 'X' ? 'O' : 'X';
    broadcast(r, 'state', state(r));
    return {};
  },
  reset(b) {
    const { r, mark } = auth(b);
    if (!mark || !r.winner) throw 'Aún no ha terminado';
    r.starter = r.starter === 'X' ? 'O' : 'X';
    Object.assign(r, { board: Array(9).fill(null), turn: r.starter, winner: null, line: null });
    broadcast(r, 'state', state(r));
    return {};
  },
  chat(b) {
    const { r, mark } = auth(b), text = clean(b.text, 300);
    if (!mark || !text) throw 'Mensaje no válido';
    const msg = { mark, name: r.players[mark].name, text, t: Date.now() };
    r.chat.push(msg);
    if (r.chat.length > 100) r.chat.shift();
    broadcast(r, 'chat', [msg]);
    return {};
  },
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // Canal de eventos en tiempo real
  if (url.pathname === '/api/events') {
    const { r, mark } = auth({ room: url.searchParams.get('room'), id: url.searchParams.get('id') });
    if (!mark) return json(res, 404, { error: 'Sala no encontrada' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const client = { res, mark };
    r.clients.add(client);
    send(res, 'chat', r.chat);
    broadcast(r, 'state', state(r));
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); r.clients.delete(client); broadcast(r, 'state', state(r)); });
    return;
  }

  // Acciones
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const fn = actions[url.pathname.slice(5)];
    if (!fn) return json(res, 404, { error: 'No existe' });
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try { json(res, 200, fn(JSON.parse(body || '{}'))); }
      catch (e) { json(res, 400, { error: typeof e === 'string' ? e : 'Error' }); }
    });
    return;
  }

  // Archivos estáticos
  const file = path.join(PUB, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(PUB)) return json(res, 403, {});
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('\n  Tres en raya listo:\n');
  console.log(`  - Este equipo:  http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log(`  - En la red:    http://${i.address}:${PORT}`));
  console.log('');
});

// Borra salas vacías tras 10 minutos
setInterval(() => {
  for (const [code, r] of rooms) {
    r.empty = r.clients.size ? 0 : r.empty + 1;
    if (r.empty >= 10) rooms.delete(code);
  }
}, 60000);
