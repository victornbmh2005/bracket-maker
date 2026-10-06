// Ratings mode: lists of items (songs, movies…) scored 1–10 on criteria.

const myRatingLists = idStore('brackets.mineRatings');   // ids of rating lists this browser has opened

let ratingList = null;        // the open list: {id, name, criteria, items, summary}
let ratingSummaries = [];     // home page list
let ratingSort = 'order';     // order | high | low | name | unrated
const openEmbeds = new Set(); // item ids whose player is open
let scoreQueue = Promise.resolve();   // score saves run one after another

const PRESETS = {
  songs: { label: 'Songs', criteria: ['Instruments', 'Vocals', 'Lyrics', 'Production', 'Replay value'] },
  movies: { label: 'Movies', criteria: ['Story', 'Acting', 'Visuals', 'Soundtrack', 'Rewatch value'] },
  custom: { label: 'Custom', criteria: [] },
};

// 1 = red … 10 = green
function scoreBadge(score, size = '') {
  if (score === null || score === undefined) return `<span class="score none ${size}">–</span>`;
  const h = Math.round(((score - 1) / 9) * 120);
  return `<span class="score ${size}" style="--h:${h}">${score.toFixed(1)}</span>`;
}

// ---------- Loading ----------
async function loadRatingSummaries() {
  const mine = myRatingLists.get();
  ratingSummaries = mine.length ? await api.listRatingLists(mine) : [];
  const found = new Set(ratingSummaries.map(s => s.id));
  myRatingLists.set(mine.filter(id => found.has(id)));
}

async function openRatingList(id) {
  if (!ratingList || ratingList.id !== id) {
    view.screen = 'loading';
    render();
    openEmbeds.clear();
    try {
      ratingList = await api.getRatingList(id);
    } catch (err) {
      if (err.status === 404) myRatingLists.remove(id);
      errorMessage = err.status === 404 ? "This rating list doesn't exist. It may have been deleted." : err.message;
      view.screen = 'error';
      render();
      return;
    }
  }
  myRatingLists.add(id);
  homeTab = 'ratings';
  view.screen = 'rating';
  render();
}

const reloadRatingList = async () => { ratingList = await api.getRatingList(ratingList.id); };

// ---------- Home ----------
function ratingsHomeHtml() {
  if (!ratingSummaries.length) {
    return `
      <div class="empty-state">
        <p><strong>No rating lists yet.</strong></p>
        <p class="muted">Make a list (a playlist, your favorite movies…), choose what to rate them on, and score each one from 1 to 10.</p>
      </div>`;
  }
  return `<div class="tlist">${ratingSummaries.map(s => `
    <div class="tcard">
      <div class="tcovers">${s.preview.map(p => imgTag(p, 'mini')).join('')}</div>
      <div class="tinfo">
        <h2>${esc(s.name)}</h2>
        <p>${plural(s.item_count, 'item')} · ${plural(s.criteria_count, 'criterion', 'criteria')} · ${s.complete_items}/${s.item_count} fully rated</p>
      </div>
      ${scoreBadge(s.score, 'large')}
      <div class="row">
        <button class="btn primary" data-action="open-list" data-id="${s.id}">Open</button>
        <button class="btn ghost danger" data-action="delete-list" data-id="${s.id}">Delete</button>
      </div>
    </div>`).join('')}</div>`;
}

function newListModalHtml() {
  return `
    <div class="sheet dialog" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <h2>New rating list</h2>
        <button class="btn ghost" data-action="close">Close ✕</button>
      </div>
      <form id="newlistform" autocomplete="off">
        <label class="field">Name
          <input type="text" name="lname" maxlength="80" placeholder="e.g. My 2026 playlist" required>
        </label>
        <p class="muted">What will you rate them on? You can rename, add or remove criteria later.</p>
        ${Object.entries(PRESETS).map(([key, p], i) => `
          <label class="option">
            <input type="radio" name="preset" value="${key}" ${i === 0 ? 'checked' : ''}>
            <span><strong>${p.label}</strong><br><span class="muted small">${p.criteria.length ? p.criteria.join(' · ') : 'Start empty and add your own'}</span></span>
          </label>`).join('')}
        <div class="row" style="justify-content:flex-end">
          <button class="btn primary">Create list →</button>
        </div>
      </form>
    </div>`;
}

// ---------- The list page ----------
function summaryHtml() {
  const { summary, criteria } = ratingList;
  return `
    <div class="rsum-score">
      ${scoreBadge(summary.score, 'huge')}
      <div>
        <div class="muted small">Overall rating</div>
        <div>${summary.complete_items} of ${plural(summary.item_count, 'item')} fully rated${summary.rated_items > summary.complete_items ? ` · ${summary.rated_items - summary.complete_items} partly` : ''}</div>
      </div>
    </div>
    <div class="rsum-crit">
      ${criteria.length ? criteria.map(c => `
        <div class="cbar">
          <span>${esc(c.name)}</span>
          <div class="bar"><div style="width:${c.average ? c.average * 10 : 0}%; --h:${c.average ? Math.round(((c.average - 1) / 9) * 120) : 0}"></div></div>
          <span class="cval">${c.average === null ? '–' : c.average.toFixed(1)}</span>
        </div>`).join('') : '<p class="muted">No criteria yet. Add some below.</p>'}
    </div>`;
}

function criteriaEditorHtml() {
  const { criteria } = ratingList;
  return `
    <details class="panel crit-editor" ${criteria.length ? '' : 'open'}>
      <summary><strong>Criteria</strong> <span class="muted">(${criteria.length}) · rename, add or remove</span></summary>
      <div class="crit-list">
        ${criteria.map(c => `
          <div class="crit-edit">
            <input type="text" value="${esc(c.name)}" maxlength="40" data-onchange="rename-criterion" data-id="${c.id}" aria-label="Criterion name">
            <button class="btn small ghost danger" data-action="delete-criterion" data-id="${c.id}" title="Delete criterion">✕</button>
          </div>`).join('')}
      </div>
      <form id="critform" class="row" autocomplete="off">
        <input type="text" name="cname" maxlength="40" placeholder="New criterion, e.g. Originality" required>
        <button class="btn small primary">Add</button>
      </form>
    </details>`;
}

function scaleHtml(item, c) {
  const current = item.scores[c.id];
  return Array.from({ length: 10 }, (_, k) => k + 1).map(v => `
    <button class="sc ${current === v ? 'on' : ''} ${current >= v ? 'fill' : ''}" data-action="score"
      data-item="${item.id}" data-crit="${c.id}" data-v="${v}" title="${current === v ? 'Click again to clear' : v}">${v}</button>`).join('');
}

function itemHtml(item) {
  const { criteria } = ratingList;
  return `
    <div class="ritem ${item.id === editingId ? 'editing' : ''}" id="ri-${item.id}">
      <div class="ri-head">
        <button class="ri-open" data-action="rate-item" data-id="${item.id}" title="Rate full screen">${imgTag(item, 'mini')}</button>
        <div class="ri-info">
          <button class="name ri-open" data-action="rate-item" data-id="${item.id}" title="Rate full screen">${esc(item.name)}</button>
          <div class="row">
            <button class="btn small" data-action="rate-item" data-id="${item.id}">⤢ Rate</button>
            ${item.link ? `<button class="btn small ghost" data-action="toggle-embed" data-id="${item.id}">${openEmbeds.has(item.id) ? '■ Hide player' : `${linkKind(item.link)}`}</button>` : ''}
            <button class="btn small ghost" data-action="edit-item" data-id="${item.id}">Edit</button>
            <button class="btn small ghost danger" data-action="remove-item" data-id="${item.id}">Remove</button>
          </div>
        </div>
        <div class="ri-score" data-iscore="${item.id}" data-size="large">${scoreBadge(item.score, 'large')}</div>
      </div>
      <div class="embed-slot" id="rie-${item.id}">${openEmbeds.has(item.id) ? playerHtml(item) : ''}</div>
      ${criteria.length ? `<div class="ri-crit">${criteria.map(c => `
        <div class="crow">
          <span class="cname">${esc(c.name)}</span>
          <div class="scale" data-scale="${item.id}:${c.id}">${scaleHtml(item, c)}</div>
        </div>`).join('')}</div>` : ''}
    </div>`;
}

const playerHtml = item => embedFor(item.link) || `<a class="link" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>`;

function sortedItems() {
  const items = [...ratingList.items];
  const byScore = dir => (a, b) => (a.score === null) - (b.score === null) || dir * ((a.score ?? 0) - (b.score ?? 0));
  if (ratingSort === 'high') items.sort(byScore(-1));
  if (ratingSort === 'low') items.sort(byScore(1));
  if (ratingSort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
  if (ratingSort === 'unrated') items.sort((a, b) => a.complete - b.complete || a.rated - b.rated);
  return items;
}

function renderRatingList() {
  const list = ratingList;
  const editing = editingId ? list.items.find(i => i.id === editingId) : null;
  const sorts = [['order', 'List order'], ['high', 'Highest score'], ['low', 'Lowest score'], ['name', 'Name'], ['unrated', 'Least rated first']];
  $app.innerHTML = `
    <header class="top">
      <div class="row">
        <button class="btn ghost" data-action="home">← All</button>
        <input class="title-input" id="title" value="${esc(list.name)}" maxlength="80" aria-label="List name">
      </div>
      <div class="row">
        <button class="btn ghost" data-action="copy-link">Copy link</button>
        <button class="btn ghost danger" data-action="delete-current">Delete</button>
      </div>
    </header>
    <div class="panel rsum" id="rating-summary">${summaryHtml()}</div>
    ${criteriaEditorHtml()}
    <div class="setup">
      ${itemFormsHtml({ editing, locked: false, noun: 'item' })}
      <section>
        <div class="startbar">
          <div class="row">
            <span class="muted">${plural(list.items.length, 'item')}</span>
            <button class="btn small ghost" data-action="refresh-list" title="Reload from the server">↻ Refresh</button>
          </div>
          ${list.items.length && list.criteria.length ? '<button class="btn primary" data-action="rate-start">⤢ Rate one by one</button>' : ''}
          <label class="row muted">Sort
            <select data-onchange="sort-items">${sorts.map(([k, l]) => `<option value="${k}" ${ratingSort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          </label>
        </div>
        ${list.items.length
          ? `<div class="ritems">${sortedItems().map(itemHtml).join('')}</div>`
          : '<div class="empty-state"><p class="muted">Add items to rate: one by one, or import a YouTube playlist or Spotify songs.</p></div>'}
      </section>
    </div>`;
  afterItemForms(editing);
  if (selectTitle) {
    selectTitle = false;
    document.getElementById('title').select();
  }
}

// After a score changes: update only the numbers, so open players keep playing.
function applyScoreChange(res) {
  const item = ratingList.items.find(i => i.id === res.item.id);
  if (item) {
    Object.assign(item, { score: res.item.score, rated: res.item.rated, complete: res.item.complete });
    // The list card and the full-screen view both show this item's score
    document.querySelectorAll(`[data-iscore="${item.id}"]`).forEach(el => { el.innerHTML = scoreBadge(item.score, el.dataset.size); });
  }
  const crit = ratingList.criteria.find(c => c.id === res.criterion.id);
  if (crit) Object.assign(crit, res.criterion);
  ratingList.summary = res.summary;
  const sum = document.getElementById('rating-summary');
  if (sum) sum.innerHTML = summaryHtml();
}

function deleteRatingList(id, name) {
  if (!confirm(`Delete "${name}" and all its scores? This can't be undone.`)) return;
  run(async () => {
    try {
      await api.deleteRatingList(id);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    myRatingLists.remove(id);
    ratingList = null;
    if (location.hash.startsWith('#/r/')) location.hash = '#/ratings';
    else await loadHome('ratings');
    toast(`Deleted "${name}".`);
  });
}

// Sets (value 1–10) or clears (null) one score. The screen updates right away;
// saves run one after another, and the averages come back from the server.
function setItemScore(itemId, critId, value) {
  const item = ratingList.items.find(i => i.id === itemId);
  const criterion = ratingList.criteria.find(c => c.id === critId);
  if (!item || !criterion) return;
  if (value === null) {
    if (item.scores[critId] === undefined) return;
    delete item.scores[critId];
  } else {
    if (item.scores[critId] === value) return;
    item.scores[critId] = value;
  }
  // The list card and the full-screen view both show this scale
  document.querySelectorAll(`[data-scale="${itemId}:${critId}"]`).forEach(el => { el.innerHTML = scaleHtml(item, criterion); });

  const listId = ratingList.id;
  scoreQueue = scoreQueue.then(async () => {
    try {
      const res = value === null
        ? await api.clearScore(itemId, critId)
        : await api.setScore({ item_id: itemId, criterion_id: critId, score: value });
      if (ratingList?.id === listId) applyScoreChange(res);
    } catch (err) {
      toast(err.message, true);
      if (ratingList?.id === listId) {
        await reloadRatingList();
        render();
      }
    }
  });
}

// ---------- Full-screen rating (one item at a time) ----------
// view.focus = { order: [item ids], index, crit: highlighted criterion index }
const firstUnscored = item => Math.max(0, ratingList.criteria.findIndex(c => item.scores[c.id] === undefined));

function openFocus(order, index) {
  if (!order.length) return;
  const item = ratingList.items.find(i => i.id === order[index]);
  view.focus = { order, index, crit: firstUnscored(item) };
  renderModal();
}

function moveFocus(index) {
  const { order } = view.focus;
  if (index < 0 || index >= order.length) return;
  const item = ratingList.items.find(i => i.id === order[index]);
  view.focus = { order, index, crit: firstUnscored(item) };
  renderModal();   // new item → new player
}

// Highlight a criterion row without re-rendering (so the player keeps playing)
function setFocusCriterion(k) {
  view.focus.crit = Math.min(Math.max(k, 0), ratingList.criteria.length - 1);
  document.querySelectorAll('.frow').forEach((row, i) => row.classList.toggle('current', i === view.focus.crit));
}

function focusHtml() {
  const { order, index, crit } = view.focus;
  const item = ratingList.items.find(i => i.id === order[index]);
  if (!item) return '';
  const { criteria } = ratingList;
  const embed = item.link ? embedFor(item.link) : null;
  const isVideo = Boolean(embed && embed.includes('youtube'));
  const otherLink = item.link && !embed
    ? `<a class="link" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>`
    : '';
  const keys = '<p class="muted hint keys">Keyboard: <kbd>1</kbd>–<kbd>9</kbd> and <kbd>0</kbd> (=10) score the highlighted row · '
    + '<kbd>↑</kbd><kbd>↓</kbd> change row · <kbd>←</kbd><kbd>→</kbd> previous / next · <kbd>Esc</kbd> close</p>';
  return `
    <div class="sheet focus" role="dialog" aria-modal="true">
      <div class="sheet-head">
        <h2>${index + 1} <span class="muted">/ ${order.length}</span></h2>
        <div class="focus-progress"><div style="width:${((index + 1) / order.length) * 100}%"></div></div>
        <button class="btn ghost" data-action="close">Close ✕</button>
      </div>
      <div class="focus-grid">
        <div class="focus-media">
          ${isVideo ? embed : imgTag(item, 'big')}
          <h3>${esc(item.name)}</h3>
          ${isVideo ? '' : (embed || otherLink)}
        </div>
        <div class="focus-rate">
          <div class="focus-score">
            <span class="muted small">Score</span>
            <div data-iscore="${item.id}" data-size="huge">${scoreBadge(item.score, 'huge')}</div>
          </div>
          ${criteria.map((c, k) => `
            <div class="frow ${k === crit ? 'current' : ''}">
              <button class="fname" data-action="focus-crit" data-k="${k}">${esc(c.name)}</button>
              <div class="scale big" data-scale="${item.id}:${c.id}">${scaleHtml(item, c)}</div>
            </div>`).join('')}
          ${criteria.length ? keys : '<p class="muted">Add criteria to the list first.</p>'}
        </div>
      </div>
      <div class="focus-nav">
        <button class="btn" data-action="focus-prev" ${index === 0 ? 'disabled' : ''}>← Previous</button>
        <button class="btn ghost" data-action="focus-next-unrated">Next unrated ⤳</button>
        <button class="btn primary" data-action="focus-next">${index === order.length - 1 ? 'Done ✓' : 'Next →'}</button>
      </div>
    </div>`;
}

// Keys in the full-screen view. (Clicking inside a YouTube/Spotify player
// sends keys to the player instead; click the panel to come back.)
function focusKeydown(e) {
  if (!view.focus || e.ctrlKey || e.metaKey || e.altKey) return;
  const { criteria } = ratingList;
  if (e.key === 'ArrowRight') { e.preventDefault(); actions['focus-next'](); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus(view.focus.index - 1); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); setFocusCriterion(view.focus.crit + 1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); setFocusCriterion(view.focus.crit - 1); return; }
  if (/^[0-9]$/.test(e.key) && criteria.length) {
    e.preventDefault();
    const value = e.key === '0' ? 10 : Number(e.key);
    const itemId = view.focus.order[view.focus.index];
    setItemScore(itemId, criteria[view.focus.crit].id, value);
    setFocusCriterion(view.focus.crit + 1);   // move on to the next row
  }
}

// ---------- Actions ----------
Object.assign(actions, {
  'new-list'() {
    view.newList = true;
    renderModal();
    document.querySelector('[name=lname]')?.focus();
  },
  'open-list': el => { location.hash = '#/r/' + el.dataset.id; },
  'delete-list'(el) {
    const s = ratingSummaries.find(x => x.id === el.dataset.id);
    deleteRatingList(s.id, s.name);
  },
  'refresh-list'() {
    run(async () => {
      await reloadRatingList();
      render();
      toast('Reloaded from the server.');
    });
  },
  score(el) {
    const item = ratingList.items.find(i => i.id === el.dataset.item);
    const value = Number(el.dataset.v);
    // clicking the chosen score again clears it
    setItemScore(el.dataset.item, el.dataset.crit, item?.scores[el.dataset.crit] === value ? null : value);
    if (view.focus) {
      const k = ratingList.criteria.findIndex(c => c.id === el.dataset.crit);
      if (k >= 0) setFocusCriterion(k);
    }
  },
  'rate-start'() {
    const order = sortedItems().map(i => i.id);
    const firstOpen = order.findIndex(id => !ratingList.items.find(i => i.id === id).complete);
    openFocus(order, Math.max(0, firstOpen));
  },
  'rate-item'(el) {
    const order = sortedItems().map(i => i.id);
    openFocus(order, Math.max(0, order.indexOf(el.dataset.id)));
  },
  'focus-prev': () => moveFocus(view.focus.index - 1),
  'focus-next'() {
    if (view.focus.index >= view.focus.order.length - 1) closeModal();
    else moveFocus(view.focus.index + 1);
  },
  'focus-next-unrated'() {
    const { order, index } = view.focus;
    const next = order.findIndex((id, k) => k > index && !ratingList.items.find(i => i.id === id)?.complete);
    if (next === -1) toast('Every item after this one is fully rated. 🎉');
    else moveFocus(next);
  },
  'focus-crit': el => setFocusCriterion(Number(el.dataset.k)),
  'toggle-embed'(el) {
    const id = el.dataset.id;
    const item = ratingList.items.find(i => i.id === id);
    if (openEmbeds.has(id)) openEmbeds.delete(id);
    else openEmbeds.add(id);
    document.getElementById(`rie-${id}`).innerHTML = openEmbeds.has(id) ? playerHtml(item) : '';
    el.textContent = openEmbeds.has(id) ? '■ Hide player' : linkKind(item.link);
  },
  'edit-item'(el) {
    const id = el.dataset.id;
    run(async () => {
      // Load the latest version, in case someone else changed it
      const fresh = await api.getRatingItem(id);
      ratingList.items = ratingList.items.map(i => i.id === id ? fresh : i);
      editingId = id;
      formImage = null;
      render();
      document.querySelector('[name=pname]').focus();
      document.getElementById('pform').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  },
  'remove-item'(el) {
    const item = ratingList.items.find(i => i.id === el.dataset.id);
    if (item.rated && !confirm(`Remove "${item.name}" and its scores?`)) return;
    run(async () => {
      await api.deleteRatingItem(item.id);
      if (editingId === item.id) { editingId = null; formImage = null; }
      openEmbeds.delete(item.id);
      await reloadRatingList();
      render();
    });
  },
  'delete-criterion'(el) {
    const c = ratingList.criteria.find(x => x.id === el.dataset.id);
    if (c.rated && !confirm(`Delete "${c.name}"? Its ${plural(c.rated, 'score')} will be removed.`)) return;
    run(async () => {
      await api.deleteCriterion(c.id);
      await reloadRatingList();
      render();
    });
  },
});

// Inputs/selects that act on change
Object.assign(changes, {
  'rename-criterion'(input) {
    const name = input.value.trim();
    const c = ratingList.criteria.find(x => x.id === input.dataset.id);
    if (!name) { input.value = c.name; return; }
    run(async () => {
      const updated = await api.updateCriterion(c.id, { name });
      c.name = updated.name;
      render();
    });
  },
  'sort-items'(select) {
    ratingSort = select.value;
    render();
  },
});

forms.newlistform = (form) => {
  const name = form.elements.lname.value.trim() || 'Untitled list';
  const preset = PRESETS[form.elements.preset.value] ?? PRESETS.custom;
  run(async () => {
    ratingList = await api.createRatingList({ name, criteria: preset.criteria });
    openEmbeds.clear();
    myRatingLists.add(ratingList.id);
    view.newList = null;
    location.hash = '#/r/' + ratingList.id;
  });
};

forms.critform = (form) => {
  const name = form.elements.cname.value.trim();
  if (!name) return;
  run(async () => {
    await api.createCriterion({ list_id: ratingList.id, name });
    await reloadRatingList();
    render();
    document.querySelector('.crit-editor').open = true;
    document.querySelector('[name=cname]').focus();
  });
};

// Imports name an untitled list after the playlist
async function addImportedItems(result) {
  ratingList.items.push(...result.added);
  ratingList.summary.item_count = ratingList.items.length;
  if (ratingList.name === 'Untitled list' && result.playlist_title) {
    const renamed = await api.updateRatingList(ratingList.id, { name: result.playlist_title.slice(0, 80) });
    ratingList.name = renamed.name;
  }
  return result;
}

screens.rating = {
  render: renderRatingList,
  modal: () => (view.focus ? focusHtml() : ''),
  keydown: focusKeydown,
  reload: reloadRatingList,
  async rename(name) {
    const renamed = await api.updateRatingList(ratingList.id, { name });
    ratingList.name = renamed.name;
    return ratingList.name;
  },
  async saveItem(id, data) {
    if (id) {
      const updated = await api.updateRatingItem(id, data);
      Object.assign(ratingList.items.find(i => i.id === id), updated);
    } else {
      ratingList.items.push(await api.createRatingItem({ list_id: ratingList.id, ...data }));
      ratingList.summary.item_count = ratingList.items.length;
    }
  },
  importYoutube: async url => addImportedItems(await api.importRatingYoutube({ list_id: ratingList.id, url })),
  importSpotify: async links => addImportedItems(await api.importRatingSpotify({ list_id: ratingList.id, links })),
};
