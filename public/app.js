const $ = s => document.querySelector(s);
let session = JSON.parse(sessionStorage.getItem('ttt') || 'null'); // { room, id, mark }
let events = null;
let game = null;

const SVG = {
  X: '<svg class="x" viewBox="0 0 100 100"><line x1="18" y1="18" x2="82" y2="82"/><line x1="82" y1="18" x2="18" y2="82"/></svg>',
  O: '<svg class="o" viewBox="0 0 100 100"><circle cx="50" cy="50" r="34"/></svg>',
};

async function api(action, body = {}) {
  const res = await fetch('/api/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...session, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- Lobby ---------- */
function enter(data) {
  session = data;
  sessionStorage.setItem('ttt', JSON.stringify(session));
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#roomCode').textContent = session.room;
  $('#messages').innerHTML = '<li class="empty">Aún no hay mensajes</li>';
  connect();
}

function leave() {
  events?.close();
  session = null;
  sessionStorage.removeItem('ttt');
  $('#game').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
}

const showError = e => ($('#error').textContent = e.message);

$('#create').onclick = () => {
  session = null;
  api('create', { name: $('#name').value }).then(enter).catch(showError);
};

$('#joinForm').onsubmit = e => {
  e.preventDefault();
  session = null;
  const room = $('#code').value.trim();
  if (room.length !== 4) return showError(new Error('El código tiene 4 letras'));
  api('join', { room, name: $('#name').value }).then(enter).catch(showError);
};

$('#leave').onclick = leave;
$('#copy').onclick = () => navigator.clipboard?.writeText(session.room).then(() => toast('Código copiado'));

/* ---------- Tiempo real ---------- */
function connect() {
  events?.close();
  events = new EventSource(`/api/events?room=${session.room}&id=${session.id}`);
  events.addEventListener('state', e => render(JSON.parse(e.data)));
  events.addEventListener('chat', e => JSON.parse(e.data).forEach(addMessage));
}

/* ---------- Tablero ---------- */
const board = $('#board');
for (let i = 0; i < 9; i++) {
  const b = document.createElement('button');
  b.className = 'cell';
  b.onclick = () => api('move', { cell: i }).catch(() => {});
  board.append(b);
}

function render(s) {
  const prev = game;
  game = s;
  const me = session.mark;
  const canPlay = s.players.O && !s.winner && s.turn === me;

  [...board.children].forEach((cell, i) => {
    const v = s.board[i];
    if (!prev || prev.board[i] !== v) cell.innerHTML = v ? SVG[v] : '';
    cell.disabled = !canPlay || !!v;
    const win = s.line?.includes(i);
    cell.className = 'cell' + (win ? ' win w' + v.toLowerCase() : '');
  });
  board.classList.toggle('dim', !!s.winner);

  for (const m of ['X', 'O']) {
    const p = s.players[m];
    const el = $(`.team[data-mark="${m}"]`);
    $('#name' + m).textContent = p ? p.name + (m === me ? ' (tú)' : '') : 'Esperando…';
    el.classList.toggle('offline', !p || !p.online);
    el.classList.toggle('active', !!p && !s.winner && s.turn === m && !!s.players.O);
    $('#score' + m).textContent = s.scores[m];
  }
  $('#draws').textContent = s.scores.draw;

  const status = $('#status');
  const other = s.players[me === 'X' ? 'O' : 'X'];
  if (!s.players.O) status.innerHTML = `Comparte el código <b>${session.room}</b> con el otro equipo`;
  else if (s.winner === 'draw') status.innerHTML = '<b>¡Empate!</b>';
  else if (s.winner) status.innerHTML = s.winner === me ? '<b>¡Habéis ganado!</b> 🎉' : `Gana <b></b>`;
  else if (other && !other.online) status.textContent = 'El otro equipo se ha desconectado…';
  else status.innerHTML = s.turn === me ? '<b>Vuestro turno</b>' : 'Turno de <b></b>';
  const slot = status.querySelector('b:empty');
  if (slot) slot.textContent = s.players[s.winner || s.turn].name; // textContent evita inyectar HTML

  $('#again').classList.toggle('hidden', !s.winner);
  if (prev && prev.players.O && !prev.players.O.online && s.players.O?.online && me === 'X') toast('El otro equipo ha vuelto');
  if (prev && !prev.players.O && s.players.O && me === 'X') toast(`${s.players.O.name} se ha unido`);
}

$('#again').onclick = () => api('reset').catch(() => {});

/* ---------- Chat ---------- */
function addMessage(m) {
  const list = $('#messages');
  list.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.className = 'm' + m.mark.toLowerCase() + (m.mark === session.mark ? ' me' : '');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = m.name;
  li.append(who, document.createTextNode(m.text));
  list.append(li);
  list.scrollTop = list.scrollHeight;
}

$('#chatForm').onsubmit = e => {
  e.preventDefault();
  const input = $('#msg');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  api('chat', { text }).catch(() => toast('No se pudo enviar'));
};

/* ---------- Reanudar sesión al recargar ---------- */
if (session) api('check').then(() => enter(session)).catch(leave);
