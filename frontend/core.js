// Shared by both modes: state, helpers, routing, the home screen, the
// add/import forms, and the event plumbing. tournaments.js and ratings.js
// register their screens, actions (buttons) and forms in the objects below.

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');

const screens = {};   // name → { render(), modal(), keydown(), reload(), saveItem(), importYoutube(), importSpotify(), rename() }
const actions = {};   // data-action name → (element, event) => …
const forms = {};     // form id → (form, event) => …
const changes = {};   // data-onchange name → (input) => …   (inputs/selects that act on change)

// ---------- Shared state ----------
let view = { screen: 'loading', match: null, picker: null, newList: null, focus: null };
let homeTab = 'tournaments';   // tournaments | ratings
let errorMessage = '';
let editingId = null;          // item/participant being edited in the add form
let formImage = null;          // uploaded (resized) image data URL waiting in the add form
let selectTitle = false;       // select the title input after the next render
let busy = false;
let server = { status: 'checking', detail: '' };   // from GET /api/health

// ---------- "Mine" lists (ids this browser has opened) ----------
function idStore(key) {
  const get = () => {
    try {
      const ids = JSON.parse(localStorage.getItem(key));
      return Array.isArray(ids) ? ids : [];
    } catch (e) {
      return [];
    }
  };
  const set = ids => { try { localStorage.setItem(key, JSON.stringify(ids)); } catch (e) {} };
  return {
    get,
    set,
    add: id => set([id, ...get().filter(x => x !== id)]),
    remove: id => set(get().filter(x => x !== id)),
  };
}

// ---------- Helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;

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

async function copyLink(hash) {
  const url = `${location.origin}${location.pathname}${hash}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Anyone with it can open this page.');
  } catch (e) {
    prompt('Copy this link:', url);
  }
}

// ---------- Saving to the server ----------
// Runs one server action at a time. On failure: show the error, and let the
// open screen reload from the server so it matches what's saved.
async function run(task) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try {
    await task();
  } catch (err) {
    toast(err.message, true);
    const screen = screens[view.screen];
    if (screen?.reload) {
      try { await screen.reload(); } catch (e) {}
      render();
    }
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

// ---------- Routing ----------
//   #/              home, tournaments tab     #/t/<id>[/<tab>]   a tournament
//   #/ratings       home, ratings tab         #/r/<id>           a rating list
async function route() {
  view.match = null;
  view.picker = null;
  view.newList = null;
  view.focus = null;
  editingId = null;
  formImage = null;
  const hash = location.hash;
  let m;
  if ((m = hash.match(/^#\/t\/([0-9a-f-]{36})(?:\/(\w+))?$/i))) await openTournament(m[1], m[2]);
  else if ((m = hash.match(/^#\/r\/([0-9a-f-]{36})$/i))) await openRatingList(m[1]);
  else await loadHome(hash === '#/ratings' ? 'ratings' : 'tournaments');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function goHome() {
  const target = homeTab === 'ratings' ? '#/ratings' : '#/';
  if (location.hash === target || (target === '#/' && location.hash === '')) route();
  else location.hash = target;
}

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

async function loadHome(tabName) {
  homeTab = tabName;
  view.screen = 'loading';
  render();
  checkHealth();
  try {
    if (tabName === 'ratings') await loadRatingSummaries();
    else await loadTournamentSummaries();
    view.screen = 'home';
  } catch (err) {
    errorMessage = err.message;
    view.screen = 'error';
  }
  render();
}

// ---------- Rendering ----------
function render() {
  if (view.screen === 'loading') renderMessage('<p>Loading…</p>');
  else if (view.screen === 'error') renderError();
  else if (view.screen === 'home') renderHome();
  else screens[view.screen].render();
  renderModal();
}

function renderModal() {
  const html = view.screen === 'home' ? (view.newList ? newListModalHtml() : '') : (screens[view.screen]?.modal?.() ?? '');
  $modal.innerHTML = html;
  $modal.hidden = !html;
}

function closeModal() {
  view.match = null;
  view.picker = null;
  view.newList = null;
  view.focus = null;
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
      <button class="btn ghost" data-action="home">← Home</button>
    </div>`);
}

function serverBadge() {
  const label = { checking: 'Checking server…', online: 'Server online', offline: 'Server offline' }[server.status];
  return `<button class="server-status ${server.status}" id="server-status" data-action="health" title="${esc(server.detail)}">
    <span class="dot"></span>${label}</button>`;
}

function renderHome() {
  const ratings = homeTab === 'ratings';
  $app.innerHTML = `
    <header class="top">
      <div class="row">
        <h1 class="logo">Bracket <span>Maker</span></h1>
        ${serverBadge()}
      </div>
      ${ratings
        ? '<button class="btn primary" data-action="new-list">+ New rating list</button>'
        : '<button class="btn primary" data-action="new">+ New tournament</button>'}
    </header>
    <nav class="tabs">
      <a class="tab ${ratings ? '' : 'active'}" href="#/">🏆 Tournaments</a>
      <a class="tab ${ratings ? 'active' : ''}" href="#/ratings">⭐ Ratings</a>
    </nav>
    ${ratings ? ratingsHomeHtml() : tournamentsHomeHtml()}`;
}

// ---------- The add/import forms (participants and rating items) ----------
// Each screen supplies: the item being edited, whether the forms are locked,
// and the words to use ("participant" / "song").
function itemFormsHtml({ editing, locked, noun }) {
  const imageUrl = editing && editing.image && !editing.image.startsWith('data:') ? editing.image : '';
  return `
    <fieldset class="side" ${locked ? 'disabled' : ''}>
      <form class="panel" id="pform" autocomplete="off">
        <h2>${editing ? `Edit ${noun}` : `Add ${noun}`}</h2>
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
        <p class="muted hint">Each video is added with its title, thumbnail and player. The playlist must be public or unlisted.</p>
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
    </fieldset>`;
}

// Call after rendering the forms: restores an uploaded image being edited and draws the preview.
function afterItemForms(editing) {
  if (editing && editing.image && editing.image.startsWith('data:') && formImage === null) formImage = editing.image;
  updatePreview();
}

function updatePreview() {
  const el = document.getElementById('preview');
  const form = document.getElementById('pform');
  if (!el || !form) return;
  const src = formImage || safeUrl(form.elements.pimage.value, false);
  const name = form.elements.pname.value || '?';
  el.innerHTML = src ? imgTag({ name, image: src }, 'big') : '';
}

// Same rule as the backend: track links or spotify:track: URIs, no repeats
function countSpotifyTracks(text) {
  const ids = text.match(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)[A-Za-z0-9]{22}/g) || [];
  return new Set(ids.map(s => s.slice(-22))).size;
}

// Shared by both import forms: the screen does the request and adds the
// results; this handles the button text and the summary message.
function runImport(form, request, noun) {
  const button = form.querySelector('button');
  const label = button.textContent;
  button.textContent = 'Importing…';
  run(async () => {
    try {
      const result = await request();
      let message = `Added ${plural(result.added.length, noun)}.`;
      if (result.skipped_unavailable) message += ` Skipped ${result.skipped_unavailable} unavailable.`;
      if (result.truncated) message += ' Stopped at the 256 limit.';
      toast(message);
      render();
    } finally {
      if (button.isConnected) button.textContent = label;
    }
  });
}

forms.pform = (form) => {
  const f = form.elements;
  const name = f.pname.value.trim();
  if (!name) return;
  const data = { name, image: formImage || safeUrl(f.pimage.value, false), link: safeUrl(f.plink.value, false) };
  run(async () => {
    await screens[view.screen].saveItem(editingId, data);
    editingId = null;
    formImage = null;
    render();
    document.querySelector('[name=pname]')?.focus();
  });
};
forms.ytform = (form) => {
  const url = form.elements.ytlist.value.trim();
  const screen = screens[view.screen];
  if (url) runImport(form, () => screen.importYoutube(url), 'video');
};
forms.spform = (form) => {
  const links = form.elements.splinks.value;
  if (!countSpotifyTracks(links)) return toast('No Spotify track links found in that text.', true);
  const screen = screens[view.screen];
  runImport(form, () => screen.importSpotify(links), 'song');
};

// ---------- Shared actions ----------
Object.assign(actions, {
  home: () => goHome(),
  retry: () => route(),
  close: () => closeModal(),
  health(el) {
    server = { status: 'checking', detail: '' };
    el.outerHTML = serverBadge();
    checkHealth();
  },
  'cancel-edit'() {
    editingId = null;
    formImage = null;
    render();
  },
  'clear-image'() {
    formImage = null;
    document.querySelector('[name=pimage]').value = '';
    document.getElementById('file').value = '';
    updatePreview();
  },
});

// ---------- Event plumbing ----------
document.addEventListener('click', e => {
  if (e.target === $modal) return closeModal();
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const handler = actions[el.dataset.action];
  if (handler) handler(el, e);
});

document.addEventListener('submit', e => {
  const handler = forms[e.target.id];
  if (!handler) return;
  e.preventDefault();
  handler(e.target, e);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$modal.hidden) return closeModal();
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;   // typing, not shortcuts
  screens[view.screen]?.keydown?.(e);
});

document.addEventListener('change', async e => {
  const handler = changes[e.target.dataset.onchange];
  if (handler) return handler(e.target);
  if (e.target.id === 'title') {
    const fallback = view.screen === 'rating' ? 'Untitled list' : 'Untitled tournament';
    const name = e.target.value.trim() || fallback;
    run(async () => {
      e.target.value = await screens[view.screen].rename(name);
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
      ? (n ? `${plural(n, 'song')} found` : 'No Spotify track links found yet')
      : '';
  }
});
