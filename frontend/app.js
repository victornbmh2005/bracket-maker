const MINE_KEY = 'brackets.mine';   // ids of tournaments this browser has opened
const OLD_KEY = 'brackets.v1';      // data from the old browser-only version
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

// ---------- State ----------
let view = { screen: 'loading', match: null, picker: null };   // screen: loading | home | tournament | error
let current = null;     // the open tournament: {id, name, participants, latest_run, run_count}
let tab = 'participants';   // participants | bracket | stats | history
let stats = null;       // GET /tournaments/:id/stats, loaded on the Stats tab
let statsSort = null;   // [column, 'asc' | 'desc'], or null for the server's order
let history = null;     // GET /runs?tournament_id=, loaded on the History tab
let historyRun = null;  // a past run opened in the History tab
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
// The server builds each run's bracket. Picks are made here on a copy of the
// run's rounds, sent with PATCH /api/runs/:id, and the server's answer is kept.

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

const champion = run => run.rounds[run.rounds.length - 1][0].winner;
const hasPlayIn = run => run.rounds.length > 1 && run.rounds[0].some(m => m.a === null || m.b === null);
const isOneSided = m => m.a === null || m.b === null;
function roundName(run, r) {
  if (r === 0 && hasPlayIn(run)) return 'Play-in';
  const fromEnd = run.rounds.length - 1 - r;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return 'Round of ' + run.rounds[r].length * 2;
}
function counts(run) {
  let done = 0, total = 0;
  run.rounds.forEach((round, r) => round.forEach(m => {
    if (r === 0 && isOneSided(m)) return;   // straight through, not a real match
    total++;
    if (m.winner !== null) done++;
  }));
  return { done, total };
}
function runLabel(run) {
  const size = run.rounds[0].length * 2;
  if (run.mode === 'cut') return `Cut to ${size} · ${run.sat_out.length} sat out`;
  return hasPlayIn(run) ? 'Everyone plays · with play-in' : 'Everyone plays';
}
function summaryStatus(s) {
  const runs = s.run_count > 1 ? ` · ${s.run_count} runs` : '';
  if (s.status === 'setup') return 'Setting up';
  if (s.status === 'finished') return `Run #${s.run_number} winner: ${esc(s.champion?.name ?? '?')}${runs}`;
  return `Run #${s.run_number} in progress · ${s.matches_done}/${s.matches_total} matches${runs}`;
}

const activeOf = t => t.participants.filter(p => !p.archived);
const inProgress = t => Boolean(t.latest_run && !t.latest_run.finished_at);

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
  const wasFinished = Boolean(current.latest_run.finished_at);
  current.latest_run = await api.updateRun(current.latest_run.id, { rounds });
  view.match = null;
  render();
  const champ = current.latest_run.champion_id;
  if (champ && !wasFinished) toast(`🏆 ${person(current, champ).name} wins run #${current.latest_run.number}!`);
}

// ---------- Routing ----------
// #/ = home, #/t/<id> = a tournament, #/t/<id>/<tab> = one of its tabs
const TABS = ['participants', 'bracket', 'stats', 'history'];

async function route() {
  view.match = null;
  view.picker = null;
  editingId = null;
  formImage = null;
  const m = location.hash.match(/^#\/t\/([0-9a-f-]{36})(?:\/(\w+))?$/i);
  if (m) await openTournament(m[1], TABS.includes(m[2]) ? m[2] : null);
  else await loadHome();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

const tabLink = (tab, t = current) => `#/t/${t.id}/${tab}`;

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

async function openTournament(id, requestedTab) {
  const switching = !current || current.id !== id;
  if (switching) {
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
    stats = null;
    history = null;
  }
  historyRun = null;
  addMine(id);
  tab = requestedTab || (current.latest_run ? 'bracket' : 'participants');
  view.screen = 'tournament';
  render();

  // Tabs whose data is loaded separately
  try {
    if (tab === 'stats') {
      stats = await api.tournamentStats(id);
      if (tab === 'stats') render();
    }
    if (tab === 'history') {
      history = await api.listRuns(id);
      if (tab === 'history') render();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Rendering ----------
function render() {
  if (view.screen === 'loading') renderMessage('<p>Loading…</p>');
  else if (view.screen === 'error') renderError();
  else if (view.screen === 'home') renderHome();
  else renderTournament(current);
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

// The tournament screen: header, tabs, then the chosen tab.
function renderTournament(t) {
  const lr = t.latest_run;
  const tabs = [
    ['participants', `Participants <span class="count">${activeOf(t).length}</span>`],
    ['bracket', lr ? `Bracket <span class="count">#${lr.number}</span>` : 'Bracket'],
    ['stats', 'Stats'],
    ['history', `History <span class="count">${t.run_count}</span>`],
  ];
  const body = { participants: participantsTab, bracket: bracketTab, stats: statsTab, history: historyTab }[tab](t);
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
    <nav class="tabs">
      ${tabs.map(([key, label]) => `<a class="tab ${tab === key ? 'active' : ''}" href="${tabLink(key, t)}">${label}</a>`).join('')}
    </nav>
    ${body}`;

  if (tab === 'participants') {
    if (editingId) {
      const editing = person(t, editingId);
      if (editing && editing.image && editing.image.startsWith('data:') && formImage === null) formImage = editing.image;
    }
    updatePreview();
  }
  if (selectTitle) {
    selectTitle = false;
    document.getElementById('title').select();
  }
}

function startButton(t, label) {
  const n = activeOf(t).length;
  return `<button class="btn primary" data-action="start" ${n < 2 ? 'disabled title="Add at least 2 participants"' : ''}>${label}</button>`;
}

function participantsTab(t) {
  const people = activeOf(t);
  const locked = inProgress(t);
  const editing = editingId ? person(t, editingId) : null;
  const imageUrl = editing && editing.image && !editing.image.startsWith('data:') ? editing.image : '';
  const nextRun = (t.latest_run?.number ?? 0) + 1;
  return `
    ${locked ? `
      <div class="notice">
        <span>Run #${t.latest_run.number} is in progress, so participants are locked until it's finished.</span>
        <a class="btn small primary" href="${tabLink('bracket', t)}">Go to bracket →</a>
      </div>` : ''}
    <div class="setup">
      <fieldset class="side" ${locked ? 'disabled' : ''}>
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
      </fieldset>
      <section>
        <div class="startbar">
          <div class="row">
            <span class="muted">${people.length} participant${people.length === 1 ? '' : 's'}</span>
            <button class="btn small ghost" data-action="refresh-p" title="Reload participants from the server">↻ Refresh</button>
          </div>
          ${locked ? '' : startButton(t, `Start run #${nextRun} →`)}
        </div>
        ${people.length ? `<div class="grid">${people.map((p, i, all) => `
          <div class="pcard ${p.id === editingId ? 'editing' : ''}">
            <span class="seed">#${i + 1}</span>
            ${imgTag(p, 'cover')}
            <div class="meta">
              <span class="name">${esc(p.name)}</span>
              ${p.link ? `<span class="tag">${linkKind(p.link)}</span>` : ''}
              ${locked ? '' : `
              <div class="row" style="margin-top:auto">
                <button class="btn small" data-action="edit-p" data-id="${p.id}">Edit</button>
                <button class="btn small ghost danger" data-action="remove-p" data-id="${p.id}">Remove</button>
              </div>
              <div class="row">
                <button class="btn small ghost" data-action="move-p" data-id="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Move earlier">←</button>
                <button class="btn small ghost" data-action="move-p" data-id="${p.id}" data-dir="1" ${i === all.length - 1 ? 'disabled' : ''} title="Move later">→</button>
              </div>`}
            </div>
          </div>`).join('')}</div>`
        : `<div class="empty-state"><p class="muted">Add at least 2 participants to start.</p></div>`}
      </section>
    </div>`;
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

// The bracket drawing. readOnly: no clicking (history view).
function bracketHtml(t, runData, readOnly) {
  const playIn = hasPlayIn(runData);
  return `
    <div class="bracket">
      ${runData.rounds.map((round, r) => `
        <div class="round">
          <h3>${roundName(runData, r)}</h3>
          <div class="matches">
            ${round.map((m, i) => {
              // Straight through the play-in: keep the space so rounds line up, but don't draw it
              if (r === 0 && playIn && isOneSided(m)) return '<div class="match through" aria-hidden="true"></div>';
              const playable = !readOnly && m.a !== null && m.b !== null;
              const pending = playable && m.winner === null;
              return `<button class="match ${playable ? 'playable' : ''} ${pending ? 'pending' : ''}"
                        data-action="open-match" data-r="${r}" data-i="${i}" ${playable ? '' : 'disabled'}>
                ${slotHtml(t, m.a, m, 'TBD')}
                ${slotHtml(t, m.b, m, 'TBD')}
              </button>`;
            }).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}

function satOutHtml(t, runData) {
  if (!runData.sat_out.length) return '';
  return `
    <div class="satout">
      <span class="muted">Sat out this run:</span>
      ${runData.sat_out.map(id => {
        const p = person(t, id);
        return p ? `<span class="chip">${imgTag(p, 'thumb')}${esc(p.name)}</span>` : '';
      }).join('')}
    </div>`;
}

function championHtml(t, runData) {
  const champ = champion(runData);
  if (!champ) return '';
  const p = person(t, champ);
  return `
    <div class="champion">
      ${imgTag(p, 'big')}
      <div><small>🏆 Champion of run #${runData.number}</small><h2>${esc(p.name)}</h2></div>
    </div>`;
}

function bracketTab(t) {
  const lr = t.latest_run;
  if (!lr) {
    return `
      <div class="empty-state">
        <p><strong>No runs yet.</strong></p>
        <p class="muted">Add participants, then start a run. You can play the same tournament many times and compare stats.</p>
        <div class="row" style="justify-content:center;margin-top:12px">${startButton(t, 'Start run #1 →')}</div>
      </div>`;
  }
  const { done, total } = counts(lr);
  const finished = Boolean(lr.finished_at);
  return `
    <div class="runbar">
      <div>
        <strong>Run #${lr.number}</strong> <span class="muted">· ${runLabel(lr)}</span>
        <div class="muted small">${finished ? 'Finished.' : `${done} of ${total} matches decided. Click a highlighted match to pick a winner.`}</div>
      </div>
      <div class="row">
        ${finished ? `${startButton(t, `Run again →`)} <a class="btn ghost" href="${tabLink('stats', t)}">See stats</a>` : ''}
        <button class="btn ghost danger" data-action="delete-run" data-id="${lr.id}">Delete this run</button>
      </div>
    </div>
    ${championHtml(t, lr)}
    ${satOutHtml(t, lr)}
    ${bracketHtml(t, lr, false)}`;
}

const STAT_COLUMNS = [
  ['name', 'Participant', 'asc'],
  ['titles', 'Titles', 'desc'],
  ['win_rate', 'Win rate', 'desc'],
  ['wins', 'W–L', 'desc'],
  ['best_finish_rank', 'Best finish', 'asc'],
  ['avg_wins', 'Wins / run', 'desc'],
  ['runs_played', 'Played', 'desc'],
  ['sat_out', 'Sat out', 'desc'],
];

function statsTab(t) {
  if (!stats) return '<div class="message"><p>Loading stats…</p></div>';
  if (!stats.runs_total) {
    return `<div class="empty-state"><p><strong>No stats yet.</strong></p><p class="muted">Play a run to see titles, win rates and best finishes.</p></div>`;
  }
  let rows = [...stats.participants];
  if (statsSort) {
    const [key, dir] = statsSort;
    const val = s => s[key] ?? (dir === 'asc' ? Infinity : -Infinity);
    rows.sort((x, y) => {
      const a = val(x), b = val(y);
      const c = typeof a === 'string' ? a.localeCompare(b) : a - b;
      return dir === 'asc' ? c : -c;
    });
  }
  const sortMark = key => statsSort && statsSort[0] === key ? (statsSort[1] === 'asc' ? ' ▲' : ' ▼') : '';
  return `
    <p class="muted">${stats.runs_finished} finished run${stats.runs_finished === 1 ? '' : 's'}${stats.runs_total > stats.runs_finished ? ' (plus one in progress: its wins count, its finishes don\'t yet)' : ''}. Click a column to sort.</p>
    <div class="table-wrap">
      <table class="stats">
        <thead><tr>
          <th>#</th>
          ${STAT_COLUMNS.map(([key, label, dir]) => `<th data-action="sort" data-key="${key}" data-dir="${dir}">${label}${sortMark(key)}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${rows.map((s, i) => `
            <tr class="${s.archived ? 'archived' : ''}">
              <td class="muted">${i + 1}</td>
              <td><span class="who">${imgTag(s, 'thumb')}${esc(s.name)}${s.archived ? ' <span class="tag">removed</span>' : ''}</span></td>
              <td>${s.titles ? `🏆 ${s.titles}` : '–'}</td>
              <td>${s.win_rate === null ? '–' : s.win_rate + '%'}</td>
              <td>${s.wins}–${s.losses}</td>
              <td>${s.best_finish ?? '–'}</td>
              <td>${s.avg_wins}</td>
              <td>${s.runs_played}</td>
              <td>${s.sat_out}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function historyTab(t) {
  if (!history) return '<div class="message"><p>Loading history…</p></div>';
  if (!history.length) return `<div class="empty-state"><p class="muted">No runs yet.</p></div>`;
  return `
    <div class="history">
      ${history.map(h => `
        <div class="hrow ${historyRun?.id === h.id ? 'open' : ''}">
          <strong>Run #${h.number}</strong>
          <span class="muted">${h.mode === 'cut' ? `Cut to ${h.size} · ${h.sat_out_count} sat out` : 'Everyone plays'}</span>
          <span class="muted">${new Date(h.created_at).toLocaleDateString()}</span>
          <span class="hchamp">${h.champion ? `${imgTag(h.champion, 'thumb')} 🏆 ${esc(h.champion.name)}` : '<span class="muted">In progress</span>'}</span>
          <div class="row">
            <button class="btn small" data-action="view-run" data-id="${h.id}">${historyRun?.id === h.id ? 'Hide' : 'View'}</button>
            <button class="btn small ghost danger" data-action="delete-run" data-id="${h.id}">Delete</button>
          </div>
        </div>`).join('')}
    </div>
    ${historyRun ? `
      <h3 class="section-title">Run #${historyRun.number} · ${runLabel(historyRun)}</h3>
      ${championHtml(t, historyRun)}
      ${satOutHtml(t, historyRun)}
      ${bracketHtml(t, historyRun, true)}` : ''}`;
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

// The modal is either a matchup (view.match) or the bracket size picker (view.picker).
function renderModal() {
  if (view.screen !== 'tournament' || (!view.match && !view.picker)) {
    $modal.hidden = true;
    $modal.innerHTML = '';
    return;
  }
  $modal.innerHTML = view.picker ? pickerHtml() : matchHtml();
  $modal.hidden = false;
}

function matchHtml() {
  const lr = current.latest_run;
  const { r, i } = view.match;
  const m = lr.rounds[r][i];
  return `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <h2>${roundName(lr, r)}${lr.rounds[r].length > 1 ? ` · Match ${i + 1}` : ''}</h2>
        <button class="btn ghost" data-action="close">Close ✕</button>
      </div>
      <div class="versus">
        ${contenderHtml(current, m.a, m)}
        <div class="vs">VS</div>
        ${contenderHtml(current, m.b, m)}
      </div>
      ${m.winner !== null ? '<div class="sheet-foot"><button class="btn ghost" data-action="undo">Undo pick</button></div>' : ''}
    </div>`;
}

function pickerHtml() {
  const n = activeOf(current).length;
  const options = view.picker.options;
  const describe = o => {
    if (o.mode === 'cut') return `<strong>${o.size} play</strong> · ${o.sit_out} sit out at random`;
    if (o.play_in) {
      const playIn = n - o.size / 2;   // matches in the play-in round
      return `<strong>Everyone plays</strong> · ${playIn} play-in match${playIn === 1 ? '' : 'es'} first, ${n - playIn * 2} go straight through`;
    }
    return `<strong>Everyone plays</strong> · ${o.size}-player bracket`;
  };
  return `
    <div class="sheet picker" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <h2>Start run #${(current.latest_run?.number ?? 0) + 1}</h2>
        <button class="btn ghost" data-action="close">Close ✕</button>
      </div>
      <p class="muted">${n} participants. Pick the bracket size:</p>
      <form id="startform">
        ${options.map((o, i) => `
          <label class="option">
            <input type="radio" name="size" value="${o.size}" ${i === view.picker.preselect ? 'checked' : ''}>
            <span>${describe(o)}</span>
          </label>`).join('')}
        ${options.some(o => o.mode === 'cut') ? '<p class="muted hint">Who sits out is random, but anyone who sat out before gets to play first.</p>' : ''}
        <label class="option plain"><input type="checkbox" name="shuffle" checked> Shuffle seeding (off = participant order)</label>
        <div class="row" style="justify-content:flex-end">
          <button class="btn primary">Start run →</button>
        </div>
      </form>
    </div>`;
}

function closeModal() {
  view.match = null;
  view.picker = null;
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

function deleteRun(id) {
  const number = history?.find(h => h.id === id)?.number ?? current.latest_run?.number;
  if (!confirm(`Delete run #${number}? Its results will be removed from the stats. This can't be undone.`)) return;
  run(async () => {
    await api.deleteRun(id);
    current = await api.getTournament(current.id);
    if (historyRun?.id === id) historyRun = null;
    if (tab === 'history') history = await api.listRuns(current.id);
    stats = null;
    render();
    toast(`Deleted run #${number}.`);
  });
}

async function copyLink() {
  const url = `${location.origin}${location.pathname}#/t/${current.id}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Anyone with it can view and play this tournament.');
  } catch (e) {
    prompt('Copy this link:', url);
  }
}

// Saves position = index for every active participant whose position changed.
async function saveOrder(order) {
  const changed = order.filter((p, k) => p.position !== k);
  const updated = await Promise.all(changed.map(p => api.updateParticipant(p.id, { position: order.indexOf(p) })));
  const byId = new Map(updated.map(u => [u.id, u]));
  current.participants = [...order.map(p => byId.get(p.id) || p), ...current.participants.filter(p => p.archived)];
}

document.addEventListener('click', e => {
  if (e.target === $modal) return closeModal();
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  switch (el.dataset.action) {
    case 'new':
      run(async () => {
        current = await api.createTournament({ name: 'Untitled tournament' });
        stats = null;
        history = null;
        selectTitle = true;
        location.hash = tabLink('participants');
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
        current.participants = await api.listParticipants(current.id, true);
        if (editingId && !activeOf(current).some(p => p.id === editingId)) { editingId = null; formImage = null; }
        render();
        toast('Participants reloaded from the server.');
      });
      break;
    case 'move-p': {
      const list = activeOf(current);
      const i = list.findIndex(p => p.id === el.dataset.id);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= list.length) break;
      const order = [...list];
      [order[i], order[j]] = [order[j], order[i]];
      run(async () => {
        await saveOrder(order);
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
        // Someone who played in a run is archived (kept for history), so reload
        current.participants = await api.listParticipants(current.id, true);
        if (editingId === id) { editingId = null; formImage = null; }
        stats = null;
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
    case 'start':
      run(async () => {
        const options = await api.runOptions(current.id);
        if (!options.length) throw new Error('Add at least 2 participants first.');
        // Preselect "everyone plays" when it needs no play-in, otherwise the biggest cut
        const preselect = options[0].play_in && options[1] ? 1 : 0;
        view.picker = { options, preselect };
        renderModal();
      });
      break;
    case 'delete-run':
      deleteRun(el.dataset.id);
      break;
    case 'view-run': {
      const id = el.dataset.id;
      if (historyRun?.id === id) {
        historyRun = null;
        render();
        break;
      }
      run(async () => {
        historyRun = await api.getRun(id);
        render();
      });
      break;
    }
    case 'sort': {
      const key = el.dataset.key;
      statsSort = statsSort && statsSort[0] === key
        ? [key, statsSort[1] === 'asc' ? 'desc' : 'asc']
        : [key, el.dataset.dir];
      render();
      break;
    }
    case 'open-match':
      view.match = { r: +el.dataset.r, i: +el.dataset.i };
      renderModal();
      break;
    case 'pick': {
      const draft = { rounds: structuredClone(current.latest_run.rounds) };
      advance(draft, view.match.r, view.match.i, el.dataset.pid);
      run(() => saveRounds(draft.rounds));
      break;
    }
    case 'undo': {
      const draft = { rounds: structuredClone(current.latest_run.rounds) };
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
  if (e.key === 'Escape' && (view.match || view.picker)) closeModal();
});

document.addEventListener('change', async e => {
  if (e.target.id === 'title') {
    const name = e.target.value.trim() || 'Untitled tournament';
    run(async () => {
      const renamed = await api.updateTournament(current.id, { name });
      current.name = renamed.name;
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
  // Start a run (POST /api/runs)
  if (e.target.id === 'startform') {
    e.preventDefault();
    const f = e.target.elements;
    const size = Number(f.size.value);
    if (!size) return toast('Pick a bracket size.', true);
    run(async () => {
      const newRun = await api.createRun({ tournament_id: current.id, size, shuffle: f.shuffle.checked });
      current.latest_run = newRun;
      current.run_count += 1;
      stats = null;
      history = null;
      view.picker = null;
      if (location.hash === tabLink('bracket')) render();
      else location.hash = tabLink('bracket');
    });
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
