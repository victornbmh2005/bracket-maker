const MINE_KEY = 'brackets.mine';   // ids of tournaments this browser has opened
const OLD_KEY = 'brackets.v1';      // data from the old browser-only version
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

// ---------- State ----------
let view = { screen: 'loading', match: null };   // screen: loading | home | tournament | error
let current = null;     // the open tournament: {id, name, rounds, participants: [...]}
let summaries = [];     // home page list
let errorMessage = '';
let editingId = null;   // participant being edited in setup
let formImage = null;   // uploaded (resized) image data URL waiting in the form
let selectTitle = false;
let busy = false;
let server = { status: 'checking', detail: '' };   // from GET /api/health

const person = (t, id) => t.participants.find(p => p.id === id);

// ---------- "My tournaments" (this browser only) ----------
function getMine() {
  try {
    const ids = JSON.parse(localStorage.getItem(MINE_KEY));
    return Array.isArray(ids) ? ids : [];
  } catch (e) {
    return [];
  }
}
function setMine(ids) {
  try { localStorage.setItem(MINE_KEY, JSON.stringify(ids)); } catch (e) {}
}
const addMine = id => setMine([id, ...getMine().filter(x => x !== id)]);
const removeMine = id => setMine(getMine().filter(x => x !== id));

function getOldTournaments() {
  try {
    const s = JSON.parse(localStorage.getItem(OLD_KEY));
    return s && Array.isArray(s.tournaments) ? s.tournaments : [];
  } catch (e) {
    return [];
  }
}

// ---------- Helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function safeUrl(v, allowData) {
  v = (v || '').trim();
  if (!v) return '';
  if (allowData && /^data:image\//i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return '';   // block javascript: and other schemes
  return 'https://' + v;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}
function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function placeholder(name, cls) {
  return `<div class="${cls} ph" style="background:hsl(${hue(name)} 45% 32%)">${esc(initials(name))}</div>`;
}
function imgTag(p, cls) {
  if (!p.image) return placeholder(p.name, cls);
  return `<img class="${cls}" src="${esc(p.image)}" alt="" data-name="${esc(p.name)}">`;
}
// Broken image URLs fall back to the coloured initials block
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.name !== undefined) {
    img.outerHTML = placeholder(img.dataset.name, img.className);
  }
}, true);

function embedFor(link) {
  let u;
  try { u = new URL(link); } catch (e) { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let yt = null;
  if (host === 'youtube.com') {
    yt = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/) || [])[1];
  } else if (host === 'youtu.be') {
    yt = u.pathname.slice(1).split('/')[0];
  }
  if (yt) {
    return `<iframe class="embed yt" src="https://www.youtube.com/embed/${encodeURIComponent(yt)}" title="YouTube player"
      allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  }
  if (host === 'open.spotify.com') {
    const m = u.pathname.match(/\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/);
    if (m) {
      const h = (m[1] === 'track' || m[1] === 'episode') ? 152 : 352;
      return `<iframe class="embed" style="height:${h}px" src="https://open.spotify.com/embed/${m[1]}/${m[2]}" title="Spotify player"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>`;
    }
  }
  return null;
}
function linkKind(link) {
  if (!link) return '';
  const e = embedFor(link);
  if (e) return e.includes('youtube') ? '▶ YouTube' : '♫ Spotify';
  return '🔗 Link';
}

function resizeImage(file, max = 320) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not an image')); };
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * s));
      c.height = Math.max(1, Math.round(img.height * s));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.src = url;
  });
}

let toastTimer;
function toast(message, isError = false) {
  $toast.textContent = message;
  $toast.classList.toggle('error', isError);
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 4000);
}

// ---------- Bracket logic ----------
// These work on any object with {participants, rounds}. The app runs them on
// a copy, sends the new rounds to the server, and keeps what the server returns.
function buildRounds(t, shuffle) {
  const ids = t.participants.map(p => p.id);
  if (shuffle) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  }
  let size = 2;
  while (size < ids.length) size *= 2;
  const firstCount = size / 2;
  const byes = size - ids.length;
  // Spread byes evenly so no first-round match has two of them
  const byeAt = new Set();
  for (let j = 0; j < byes; j++) byeAt.add(Math.floor(j * firstCount / byes));

  const first = [];
  let k = 0;
  for (let i = 0; i < firstCount; i++) {
    if (byeAt.has(i)) first.push({ a: ids[k++], b: null, winner: null });
    else first.push({ a: ids[k++], b: ids[k++], winner: null });
  }
  t.rounds = [first];
  for (let n = firstCount / 2; n >= 1; n /= 2) {
    t.rounds.push(Array.from({ length: n }, () => ({ a: null, b: null, winner: null })));
  }
  first.forEach((m, i) => { if (m.b === null) advance(t, 0, i, m.a); });
}

// Put `val` into the next-round slot fed by match (r, i). If that changes a
// match that already had a result, clear it and keep clearing down the line.
function feedNext(t, r, i, val) {
  if (r + 1 >= t.rounds.length) return;
  const next = t.rounds[r + 1][i >> 1];
  const slot = i % 2 ? 'b' : 'a';
  if (next[slot] === val) return;
  next[slot] = val;
  if (next.winner !== null) {
    next.winner = null;
    feedNext(t, r + 1, i >> 1, null);
  }
}
function advance(t, r, i, pid) {
  const m = t.rounds[r][i];
  if (m.winner === pid) return;
  m.winner = pid;
  feedNext(t, r, i, pid);
}
function undo(t, r, i) {
  t.rounds[r][i].winner = null;
  feedNext(t, r, i, null);
}

const champion = t => t.rounds ? t.rounds[t.rounds.length - 1][0].winner : null;
function roundName(t, r) {
  const fromEnd = t.rounds.length - 1 - r;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return 'Round of ' + t.rounds[r].length * 2;
}
function counts(t) {
  let done = 0, total = 0;
  t.rounds.forEach((round, r) => round.forEach(m => {
    if (r === 0 && m.b === null) return;  // byes aren't real matches
    total++;
    if (m.winner !== null) done++;
  }));
  return { done, total };
}
function summaryStatus(s) {
  if (s.status === 'setup') return 'Setting up';
  if (s.champion) return 'Winner: ' + esc(s.champion.name);
  return `In progress · ${s.matches_done}/${s.matches_total} matches`;
}

// ---------- Saving to the server ----------
// Runs one server action at a time. On failure: show the error, reload the
// open tournament from the server so the screen matches what's saved.
async function run(task) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    await task();
  } catch (err) {
    toast(err.message, true);
    if (current && view.screen === 'tournament') {
      try { current = await api.getTournament(current.id); } catch (e) {}
      render();
    }
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

async function saveRounds(rounds) {
  current = await api.updateTournament(current.id, { rounds });
  view.match = null;
  render();
}

// ---------- Routing: #/ = home, #/t/<id> = a tournament ----------
async function route() {
  view.match = null;
  editingId = null;
  formImage = null;
  const m = location.hash.match(/^#\/t\/([0-9a-f-]{36})$/i);
  if (m) await openTournament(m[1]);
  else await loadHome();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

async function checkHealth() {
  try {
    await api.health();
    server = { status: 'online', detail: 'API and database are reachable' };
  } catch (err) {
    server = { status: 'offline', detail: err.message };
  }
  const badge = document.getElementById('server-status');
  if (badge) badge.outerHTML = serverBadge();
}

async function loadHome() {
  current = null;
  view.screen = 'loading';
  render();
  checkHealth();
  try {
    const mine = getMine();
    summaries = mine.length ? await api.listTournaments(mine) : [];
    // Forget tournaments that were deleted on the server
    const found = new Set(summaries.map(s => s.id));
    setMine(mine.filter(id => found.has(id)));
    view.screen = 'home';
  } catch (err) {
    errorMessage = err.message;
    view.screen = 'error';
  }
  render();
}

async function openTournament(id) {
  if (!current || current.id !== id) {
    view.screen = 'loading';
    render();
    try {
      current = await api.getTournament(id);
    } catch (err) {
      if (err.status === 404) removeMine(id);
      errorMessage = err.status === 404 ? "This tournament doesn't exist. It may have been deleted." : err.message;
      view.screen = 'error';
      render();
      return;
    }
  }
  addMine(id);
  view.screen = 'tournament';
  render();
}

// ---------- Rendering ----------
function render() {
  if (view.screen === 'loading') renderMessage('<p>Loading…</p>');
  else if (view.screen === 'error') renderError();
  else if (view.screen === 'home') renderHome();
  else if (current.rounds) renderBracket(current);
  else renderSetup(current);
  renderModal();
}

function renderMessage(html) {
  $app.innerHTML = `<div class="message">${html}</div>`;
}

function renderError() {
  renderMessage(`
    <h2>Something went wrong</h2>
    <p>${esc(errorMessage)}</p>
    <div class="row">
      <button class="btn" data-action="retry">Try again</button>
      <button class="btn ghost" data-action="home">← All tournaments</button>
    </div>`);
}

function serverBadge() {
  const label = { checking: 'Checking server…', online: 'Server online', offline: 'Server offline' }[server.status];
  return `<button class="server-status ${server.status}" id="server-status" data-action="health" title="${esc(server.detail)}">
    <span class="dot"></span>${label}</button>`;
}

function renderHome() {
  const old = getOldTournaments();
  $app.innerHTML = `
    <header class="top">
      <div class="row">
        <h1 class="logo">Bracket <span>Maker</span></h1>
        ${serverBadge()}
      </div>
      <button class="btn primary" data-action="new">+ New tournament</button>
    </header>
    ${old.length ? `
      <div class="panel row" style="justify-content:space-between;margin-bottom:16px">
        <span>You have ${old.length} tournament${old.length === 1 ? '' : 's'} saved only in this browser from the old version.</span>
        <button class="btn primary" data-action="import">Import to the server</button>
      </div>` : ''}
    ${summaries.length ? `<div class="tlist">${summaries.map(s => `
      <div class="tcard">
        <div class="tcovers">${s.preview.map(p => imgTag(p, 'mini')).join('')}</div>
        <div class="tinfo">
          <h2>${esc(s.name)}</h2>
          <p>${s.participant_count} participant${s.participant_count === 1 ? '' : 's'} · ${summaryStatus(s)}</p>
        </div>
        <div class="row">
          <button class="btn primary" data-action="open" data-id="${s.id}">Open</button>
          <button class="btn ghost danger" data-action="delete" data-id="${s.id}">Delete</button>
        </div>
      </div>`).join('')}</div>`
    : `<div class="empty-state">
        <p><strong>No tournaments yet.</strong></p>
        <p class="muted">Add movies, songs, anything, then pick winners until only one is left.</p>
      </div>`}`;
}

function renderSetup(t) {
  const editing = editingId ? person(t, editingId) : null;
  const imageUrl = editing && editing.image && !editing.image.startsWith('data:') ? editing.image : '';
  $app.innerHTML = `
    <header class="top">
      <div class="row">
        <button class="btn ghost" data-action="home">← All</button>
        <input class="title-input" id="title" value="${esc(t.name)}" maxlength="80" aria-label="Tournament name">
      </div>
      <div class="row">
        <button class="btn ghost" data-action="copy-link">Copy link</button>
        <button class="btn ghost danger" data-action="delete-current">Delete</button>
      </div>
    </header>
    <div class="setup">
      <div class="side">
      <form class="panel" id="pform" autocomplete="off">
        <h2>${editing ? 'Edit participant' : 'Add participant'}</h2>
        <label class="field">Name
          <input type="text" name="pname" required maxlength="80" value="${editing ? esc(editing.name) : ''}">
        </label>
        <label class="field">Image URL
          <input type="url" name="pimage" placeholder="https://… (or upload below)" value="${esc(imageUrl)}">
        </label>
        <div class="row" style="margin-bottom:6px">
          <label class="btn small">Upload image<input type="file" accept="image/*" id="file" hidden></label>
          <button type="button" class="btn small ghost" data-action="clear-image">Clear image</button>
        </div>
        <div class="preview" id="preview"></div>
        <label class="field">Link: YouTube, Spotify or any URL (optional)
          <input type="url" name="plink" placeholder="https://youtube.com/watch?v=…" value="${editing ? esc(editing.link) : ''}">
        </label>
        <div class="row">
          <button class="btn primary">${editing ? 'Save' : 'Add'}</button>
          ${editing ? '<button type="button" class="btn ghost" data-action="cancel-edit">Cancel</button>' : ''}
        </div>
      </form>
      <form class="panel" id="ytform" autocomplete="off">
        <h2>Import YouTube playlist</h2>
        <label class="field">Playlist link
          <input type="url" name="ytlist" required placeholder="https://youtube.com/playlist?list=…">
        </label>
        <p class="muted hint">Each video becomes a participant with its title, thumbnail and player. The playlist must be public or unlisted.</p>
        <button class="btn primary">Import videos</button>
      </form>
      <form class="panel" id="spform" autocomplete="off">
        <h2>Import Spotify songs</h2>
        <ol class="muted hint steps">
          <li>In the Spotify <strong>desktop app</strong>, open any playlist or album.</li>
          <li>Click one song, press <kbd>Ctrl</kbd>+<kbd>A</kbd>, then <kbd>Ctrl</kbd>+<kbd>C</kbd>.</li>
          <li>Paste below.</li>
        </ol>
        <label class="field">Track links
          <textarea name="splinks" rows="4" required placeholder="https://open.spotify.com/track/…"></textarea>
        </label>
        <p class="muted hint" id="spcount"></p>
        <button class="btn primary">Import songs</button>
      </form>
      </div>
      <section>
        <div class="startbar">
          <div class="row">
            <span class="muted">${t.participants.length} participant${t.participants.length === 1 ? '' : 's'}</span>
            <button class="btn small ghost" data-action="refresh-p" title="Reload participants from the server">↻ Refresh</button>
          </div>
          <div class="row">
            <label><input type="checkbox" id="shuffle" checked> Shuffle seeding</label>
            <button class="btn primary" data-action="start" ${t.participants.length < 2 ? 'disabled' : ''}>Start tournament →</button>
          </div>
        </div>
        ${t.participants.length ? `<div class="grid">${t.participants.map((p, i, all) => `
          <div class="pcard ${p.id === editingId ? 'editing' : ''}">
            <span class="seed">#${i + 1}</span>
            ${imgTag(p, 'cover')}
            <div class="meta">
              <span class="name">${esc(p.name)}</span>
              ${p.link ? `<span class="tag">${linkKind(p.link)}</span>` : ''}
              <div class="row" style="margin-top:auto">
                <button class="btn small" data-action="edit-p" data-id="${p.id}">Edit</button>
                <button class="btn small ghost danger" data-action="remove-p" data-id="${p.id}">Remove</button>
              </div>
              <div class="row">
                <button class="btn small ghost" data-action="move-p" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move earlier">←</button>
                <button class="btn small ghost" data-action="move-p" data-id="${p.id}" data-dir="1" ${i === all.length - 1 ? 'disabled' : ''} title="Move later">→</button>
              </div>
            </div>
          </div>`).join('')}</div>`
        : `<div class="empty-state"><p class="muted">Add at least 2 participants to start.</p></div>`}
      </section>
    </div>`;

  if (editing && editing.image && editing.image.startsWith('data:') && formImage === null) formImage = editing.image;
  updatePreview();
  if (selectTitle) {
    selectTitle = false;
    document.getElementById('title').select();
  }
}

function updatePreview() {
  const el = document.getElementById('preview');
  const form = document.getElementById('pform');
  if (!el || !form) return;
  const src = formImage || safeUrl(form.elements.pimage.value, false);
  const name = form.elements.pname.value || '?';
  el.innerHTML = src ? imgTag({ name, image: src }, 'big') : '';
}

function slotHtml(t, pid, m, emptyLabel) {
  if (pid === null) return `<div class="slot empty">${emptyLabel}</div>`;
  const p = person(t, pid);
  const cls = m.winner === null ? '' : (m.winner === pid ? 'won' : 'lost');
  return `<div class="slot ${cls}">${imgTag(p, 'thumb')}<span class="nm">${esc(p.name)}</span></div>`;
}

function renderBracket(t) {
  const champ = champion(t);
  const { done, total } = counts(t);
  $app.innerHTML = `
    <header class="top">
      <div class="row">
        <button class="btn ghost" data-action="home">← All</button>
        <h1 class="title">${esc(t.name)}</h1>
      </div>
      <div class="row">
        <button class="btn ghost" data-action="copy-link">Copy link</button>
        <button class="btn ghost danger" data-action="reset">Reset bracket</button>
        <button class="btn ghost danger" data-action="delete-current">Delete</button>
      </div>
    </header>
    <p class="progress">${done} of ${total} matches decided. Click a highlighted match to pick a winner.</p>
    ${champ ? (p => `
      <div class="champion">
        ${imgTag(p, 'big')}
        <div><small>🏆 Champion</small><h2>${esc(p.name)}</h2></div>
      </div>`)(person(t, champ)) : ''}
    <div class="bracket">
      ${t.rounds.map((round, r) => `
        <div class="round">
          <h3>${roundName(t, r)}</h3>
          <div class="matches">
            ${round.map((m, i) => {
              const playable = m.a !== null && m.b !== null;
              const pending = playable && m.winner === null;
              return `<button class="match ${playable ? 'playable' : ''} ${pending ? 'pending' : ''}"
                        data-action="open-match" data-r="${r}" data-i="${i}" ${playable ? '' : 'disabled'}>
                ${slotHtml(t, m.a, m, 'TBD')}
                ${slotHtml(t, m.b, m, r === 0 ? 'Bye' : 'TBD')}
              </button>`;
            }).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}

function contenderHtml(t, pid, m) {
  const p = person(t, pid);
  const embed = p.link ? embedFor(p.link) : null;
  const won = m.winner === pid;
  return `
    <div class="contender ${won ? 'won' : ''}">
      ${imgTag(p, 'big')}
      <h3>${esc(p.name)}</h3>
      ${embed || (p.link ? `<a class="link" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>` : '')}
      <button class="btn ${won ? '' : 'primary'}" data-action="pick" data-pid="${pid}" ${won ? 'disabled' : ''}>
        ${won ? 'Winner ✓' : 'Pick ' + esc(p.name)}
      </button>
    </div>`;
}

function renderModal() {
  if (!view.match || view.screen !== 'tournament' || !current.rounds) {
    $modal.hidden = true;
    $modal.innerHTML = '';
    return;
  }
  const t = current;
  const { r, i } = view.match;
  const m = t.rounds[r][i];
  $modal.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <h2>${roundName(t, r)}${t.rounds[r].length > 1 ? ` · Match ${i + 1}` : ''}</h2>
        <button class="btn ghost" data-action="close">Close ✕</button>
      </div>
      <div class="versus">
        ${contenderHtml(t, m.a, m)}
        <div class="vs">VS</div>
        ${contenderHtml(t, m.b, m)}
      </div>
      ${m.winner !== null ? '<div class="sheet-foot"><button class="btn ghost" data-action="undo">Undo pick</button></div>' : ''}
    </div>`;
  $modal.hidden = false;
}

function closeModal() {
  view.match = null;
  renderModal();
}

// ---------- Actions ----------
async function importOld() {
  const remaining = getOldTournaments();
  let imported = 0;
  try {
    while (remaining.length) {
      const t = remaining[0];
      const created = await api.createTournament({
        name: t.name || 'Untitled tournament',
        participants: t.participants || [],
        rounds: t.rounds || null,
      });
      addMine(created.id);
      remaining.shift();
      imported++;
    }
  } finally {
    // Keep only the ones that failed, so a retry doesn't create duplicates
    try {
      if (remaining.length) localStorage.setItem(OLD_KEY, JSON.stringify({ tournaments: remaining }));
      else localStorage.removeItem(OLD_KEY);
    } catch (e) {}
    if (imported) toast(`Imported ${imported} tournament${imported === 1 ? '' : 's'}.`);
    await loadHome();
  }
}

function deleteTournament(id, name) {
  if (!confirm(`Delete "${name}"? This deletes it for everyone who has the link, and can't be undone.`)) return;
  run(async () => {
    try {
      await api.deleteTournament(id);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    removeMine(id);
    current = null;
    if (location.hash.startsWith('#/t/')) location.hash = '#/';
    else await loadHome();
    toast(`Deleted "${name}".`);
  });
}

async function copyLink() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Anyone with it can view and play this tournament.');
  } catch (e) {
    prompt('Copy this link:', url);
  }
}

document.addEventListener('click', e => {
  if (e.target === $modal) return closeModal();
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  switch (el.dataset.action) {
    case 'new':
      run(async () => {
        current = await api.createTournament({ name: 'Untitled tournament' });
        selectTitle = true;
        location.hash = '#/t/' + current.id;
      });
      break;
    case 'open':
      location.hash = '#/t/' + el.dataset.id;
      break;
    case 'delete': {
      const s = summaries.find(x => x.id === el.dataset.id);
      deleteTournament(s.id, s.name);
      break;
    }
    case 'delete-current':
      deleteTournament(current.id, current.name);
      break;
    case 'health':
      server = { status: 'checking', detail: '' };
      el.outerHTML = serverBadge();
      checkHealth();
      break;
    case 'import':
      run(importOld);
      break;
    case 'home':
      if (location.hash === '#/' || location.hash === '') route();
      else location.hash = '#/';
      break;
    case 'retry':
      route();
      break;
    case 'copy-link':
      copyLink();
      break;
    case 'edit-p': {
      const id = el.dataset.id;
      run(async () => {
        // Load the latest version, in case someone else changed it
        const fresh = await api.getParticipant(id);
        current.participants = current.participants.map(p => p.id === id ? fresh : p);
        editingId = id;
        formImage = null;
        render();
        document.querySelector('[name=pname]').focus();
      });
      break;
    }
    case 'refresh-p':
      run(async () => {
        current.participants = await api.listParticipants(current.id);
        if (editingId && !person(current, editingId)) { editingId = null; formImage = null; }
        render();
        toast('Participants reloaded from the server.');
      });
      break;
    case 'move-p': {
      const list = current.participants;
      const i = list.findIndex(p => p.id === el.dataset.id);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= list.length) break;
      const order = [...list];
      [order[i], order[j]] = [order[j], order[i]];
      run(async () => {
        // Save position = index for every participant whose position changed
        const changed = order.filter((p, k) => p.position !== k);
        const updated = await Promise.all(changed.map(p => api.updateParticipant(p.id, { position: order.indexOf(p) })));
        const byId = new Map(updated.map(u => [u.id, u]));
        current.participants = order.map(p => byId.get(p.id) || p);
        render();
      });
      break;
    }
    case 'cancel-edit':
      editingId = null;
      formImage = null;
      render();
      break;
    case 'remove-p': {
      const id = el.dataset.id;
      run(async () => {
        await api.deleteParticipant(id);
        current.participants = current.participants.filter(p => p.id !== id);
        if (editingId === id) { editingId = null; formImage = null; }
        render();
      });
      break;
    }
    case 'clear-image':
      formImage = null;
      document.querySelector('[name=pimage]').value = '';
      document.getElementById('file').value = '';
      updatePreview();
      break;
    case 'start': {
      const draft = { participants: current.participants, rounds: null };
      buildRounds(draft, document.getElementById('shuffle').checked);
      run(() => saveRounds(draft.rounds));
      break;
    }
    case 'reset':
      if (confirm('Reset the bracket? All picks will be lost, but the participants are kept.')) {
        run(() => saveRounds(null));
      }
      break;
    case 'open-match':
      view.match = { r: +el.dataset.r, i: +el.dataset.i };
      renderModal();
      break;
    case 'pick': {
      const draft = { rounds: structuredClone(current.rounds) };
      advance(draft, view.match.r, view.match.i, el.dataset.pid);
      run(() => saveRounds(draft.rounds));
      break;
    }
    case 'undo': {
      const draft = { rounds: structuredClone(current.rounds) };
      undo(draft, view.match.r, view.match.i);
      run(() => saveRounds(draft.rounds));
      break;
    }
    case 'close':
      closeModal();
      break;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && view.match) closeModal();
});

document.addEventListener('change', async e => {
  if (e.target.id === 'title') {
    const name = e.target.value.trim() || 'Untitled tournament';
    run(async () => {
      current = await api.updateTournament(current.id, { name });
      e.target.value = current.name;
    });
  }
  if (e.target.id === 'file' && e.target.files[0]) {
    try {
      formImage = await resizeImage(e.target.files[0]);
      document.querySelector('[name=pimage]').value = '';
      updatePreview();
    } catch (err) {
      toast("That file couldn't be read as an image.", true);
    }
  }
});

document.addEventListener('input', e => {
  if (e.target.name === 'pimage') {
    formImage = null;
    updatePreview();
  }
  if (e.target.name === 'splinks') {
    const n = countSpotifyTracks(e.target.value);
    document.getElementById('spcount').textContent = e.target.value.trim()
      ? (n ? `${n} song${n === 1 ? '' : 's'} found` : 'No Spotify track links found yet')
      : '';
  }
});

// Same rule as the backend: track links or spotify:track: URIs, no repeats
function countSpotifyTracks(text) {
  const ids = text.match(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)[A-Za-z0-9]{22}/g) || [];
  return new Set(ids.map(s => s.slice(-22))).size;
}

// Shared by both import forms: call the endpoint, add the new participants,
// name an untitled tournament after the playlist, report what happened.
function runImport(form, request, noun) {
  const button = form.querySelector('button');
  const label = button.textContent;
  button.textContent = 'Importing…';
  run(async () => {
    try {
      const result = await request();
      current.participants.push(...result.added);
      if (current.name === 'Untitled tournament' && result.playlist_title) {
        const renamed = await api.updateTournament(current.id, { name: result.playlist_title.slice(0, 80) });
        current.name = renamed.name;
      }
      let message = `Added ${result.added.length} ${noun}${result.added.length === 1 ? '' : 's'}.`;
      if (result.skipped_unavailable) message += ` Skipped ${result.skipped_unavailable} unavailable.`;
      if (result.truncated) message += ' Stopped at the 256 participant limit.';
      toast(message);
      render();
    } finally {
      if (button.isConnected) button.textContent = label;
    }
  });
}

document.addEventListener('submit', e => {
  // YouTube playlist (POST /api/participants/import/youtube)
  if (e.target.id === 'ytform') {
    e.preventDefault();
    const url = e.target.elements.ytlist.value.trim();
    if (url) runImport(e.target, () => api.importYoutube({ tournament_id: current.id, url }), 'video');
  }
  // Spotify track links (POST /api/participants/import/spotify)
  if (e.target.id === 'spform') {
    e.preventDefault();
    const links = e.target.elements.splinks.value;
    if (!countSpotifyTracks(links)) return toast('No Spotify track links found in that text.', true);
    runImport(e.target, () => api.importSpotify({ tournament_id: current.id, links }), 'song');
  }
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'pform') return;
  e.preventDefault();
  const f = e.target.elements;
  const name = f.pname.value.trim();
  if (!name) return;
  const data = { name, image: formImage || safeUrl(f.pimage.value, false), link: safeUrl(f.plink.value, false) };
  run(async () => {
    if (editingId) {
      const updated = await api.updateParticipant(editingId, data);
      current.participants = current.participants.map(p => p.id === updated.id ? updated : p);
    } else {
      const created = await api.createParticipant({ tournament_id: current.id, ...data });
      current.participants.push(created);
    }
    editingId = null;
    formImage = null;
    render();
    document.querySelector('[name=pname]').focus();
  });
});

route();
