// Tournament mode: participants, runs (brackets), stats and history.

const OLD_KEY = 'brackets.v1';                    // data from the old browser-only version
const myTournaments = idStore('brackets.mine');   // ids of tournaments this browser has opened

let current = null;     // the open tournament: {id, name, participants, latest_run, run_count}
let tab = 'participants';   // participants | bracket | stats | history
let stats = null;       // GET /tournaments/:id/stats, loaded on the Stats tab
let statsSort = null;   // [column, 'asc' | 'desc'], or null for the server's order
let runHistory = null;     // GET /runs?tournament_id=, loaded on the History tab
let historyRun = null;  // a past run opened in the History tab
let summaries = [];     // home page list

const person = (t, id) => t.participants.find(p => p.id === id);
const activeOf = t => t.participants.filter(p => !p.archived);
const inProgress = t => Boolean(t.latest_run && !t.latest_run.finished_at);
const tabLink = (tabName, t = current) => `#/t/${t.id}/${tabName}`;
const TABS = ['participants', 'bracket', 'stats', 'history'];

function getOldTournaments() {
  try {
    const s = JSON.parse(localStorage.getItem(OLD_KEY));
    return s && Array.isArray(s.tournaments) ? s.tournaments : [];
  } catch (e) {
    return [];
  }
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

const champion = runData => runData.rounds[runData.rounds.length - 1][0].winner;
const hasPlayIn = runData => runData.rounds.length > 1 && runData.rounds[0].some(m => m.a === null || m.b === null);
const isOneSided = m => m.a === null || m.b === null;
function roundName(runData, r) {
  if (r === 0 && hasPlayIn(runData)) return 'Play-in';
  const fromEnd = runData.rounds.length - 1 - r;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return 'Round of ' + runData.rounds[r].length * 2;
}
function counts(runData) {
  let done = 0, total = 0;
  runData.rounds.forEach((round, r) => round.forEach(m => {
    if (r === 0 && isOneSided(m)) return;   // straight through, not a real match
    total++;
    if (m.winner !== null) done++;
  }));
  return { done, total };
}
function runLabel(runData) {
  const size = runData.rounds[0].length * 2;
  if (runData.mode === 'cut') return `Cut to ${size} · ${runData.sat_out.length} sat out`;
  return hasPlayIn(runData) ? 'Everyone plays · with play-in' : 'Everyone plays';
}
function summaryStatus(s) {
  const runs = s.run_count > 1 ? ` · ${s.run_count} runs` : '';
  if (s.status === 'setup') return 'Setting up';
  if (s.status === 'finished') return `Run #${s.run_number} winner: ${esc(s.champion?.name ?? '?')}${runs}`;
  return `Run #${s.run_number} in progress · ${s.matches_done}/${s.matches_total} matches${runs}`;
}

async function saveRounds(rounds) {
  const wasFinished = Boolean(current.latest_run.finished_at);
  current.latest_run = await api.updateRun(current.latest_run.id, { rounds });
  view.match = null;
  render();
  const champ = current.latest_run.champion_id;
  if (champ && !wasFinished) toast(`🏆 ${person(current, champ).name} wins run #${current.latest_run.number}!`);
}

// ---------- Loading ----------
async function loadTournamentSummaries() {
  const mine = myTournaments.get();
  summaries = mine.length ? await api.listTournaments(mine) : [];
  // Forget tournaments that were deleted on the server
  const found = new Set(summaries.map(s => s.id));
  myTournaments.set(mine.filter(id => found.has(id)));
}

async function openTournament(id, requestedTab) {
  if (!current || current.id !== id) {
    view.screen = 'loading';
    render();
    try {
      current = await api.getTournament(id);
    } catch (err) {
      if (err.status === 404) myTournaments.remove(id);
      errorMessage = err.status === 404 ? "This tournament doesn't exist. It may have been deleted." : err.message;
      view.screen = 'error';
      render();
      return;
    }
    stats = null;
    runHistory = null;
  }
  historyRun = null;
  myTournaments.add(id);
  homeTab = 'tournaments';
  tab = TABS.includes(requestedTab) ? requestedTab : (current.latest_run ? 'bracket' : 'participants');
  view.screen = 'tournament';
  render();

  // Tabs whose data is loaded separately
  try {
    if (tab === 'stats') {
      stats = await api.tournamentStats(id);
      if (tab === 'stats' && view.screen === 'tournament') render();
    }
    if (tab === 'history') {
      runHistory = await api.listRuns(id);
      if (tab === 'history' && view.screen === 'tournament') render();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Home ----------
function tournamentsHomeHtml() {
  const old = getOldTournaments();
  return `
    ${old.length ? `
      <div class="panel row" style="justify-content:space-between;margin-bottom:16px">
        <span>You have ${plural(old.length, 'tournament')} saved only in this browser from the old version.</span>
        <button class="btn primary" data-action="import">Import to the server</button>
      </div>` : ''}
    ${summaries.length ? `<div class="tlist">${summaries.map(s => `
      <div class="tcard">
        <div class="tcovers">${s.preview.map(p => imgTag(p, 'mini')).join('')}</div>
        <div class="tinfo">
          <h2>${esc(s.name)}</h2>
          <p>${plural(s.participant_count, 'participant')} · ${summaryStatus(s)}</p>
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

// ---------- The tournament screen ----------
function renderTournament() {
  const t = current;
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

  if (tab === 'participants') afterItemForms(editingId ? person(t, editingId) : null);
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
  const nextRun = (t.latest_run?.number ?? 0) + 1;
  return `
    ${locked ? `
      <div class="notice">
        <span>Run #${t.latest_run.number} is in progress, so participants are locked until it's finished.</span>
        <a class="btn small primary" href="${tabLink('bracket', t)}">Go to bracket →</a>
      </div>` : ''}
    <div class="setup">
      ${itemFormsHtml({ editing, locked, noun: 'participant' })}
      <section>
        <div class="startbar">
          <div class="row">
            <span class="muted">${plural(people.length, 'participant')}</span>
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
        ${finished ? `${startButton(t, 'Run again →')} <a class="btn ghost" href="${tabLink('stats', t)}">See stats</a>` : ''}
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

function statsTab() {
  if (!stats) return '<div class="message"><p>Loading stats…</p></div>';
  if (!stats.runs_total) {
    return `<div class="empty-state"><p><strong>No stats yet.</strong></p><p class="muted">Play a run to see titles, win rates and best finishes.</p></div>`;
  }
  const rows = [...stats.participants];
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
    <p class="muted">${plural(stats.runs_finished, 'finished run')}${stats.runs_total > stats.runs_finished ? ' (plus one in progress: its wins count, its finishes don\'t yet)' : ''}. Click a column to sort.</p>
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
  if (!runHistory) return '<div class="message"><p>Loading history…</p></div>';
  if (!runHistory.length) return `<div class="empty-state"><p class="muted">No runs yet.</p></div>`;
  return `
    <div class="history">
      ${runHistory.map(h => `
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

// ---------- Modals: a matchup, or the bracket size picker ----------
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
      return `<strong>Everyone plays</strong> · ${plural(playIn, 'play-in match', 'play-in matches')} first, ${n - playIn * 2} go straight through`;
    }
    return `<strong>Everyone plays</strong> · ${o.size}-player bracket`;
  };
  return `
    <div class="sheet dialog" role="dialog" aria-modal="true">
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
      myTournaments.add(created.id);
      remaining.shift();
      imported++;
    }
  } finally {
    // Keep only the ones that failed, so a retry doesn't create duplicates
    try {
      if (remaining.length) localStorage.setItem(OLD_KEY, JSON.stringify({ tournaments: remaining }));
      else localStorage.removeItem(OLD_KEY);
    } catch (e) {}
    if (imported) toast(`Imported ${plural(imported, 'tournament')}.`);
    await loadHome('tournaments');
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
    myTournaments.remove(id);
    current = null;
    if (location.hash.startsWith('#/t/')) location.hash = '#/';
    else await loadHome('tournaments');
    toast(`Deleted "${name}".`);
  });
}

function deleteRun(id) {
  const number = runHistory?.find(h => h.id === id)?.number ?? current.latest_run?.number;
  if (!confirm(`Delete run #${number}? Its results will be removed from the stats. This can't be undone.`)) return;
  run(async () => {
    await api.deleteRun(id);
    current = await api.getTournament(current.id);
    if (historyRun?.id === id) historyRun = null;
    if (tab === 'history') runHistory = await api.listRuns(current.id);
    stats = null;
    render();
    toast(`Deleted run #${number}.`);
  });
}

// Saves position = index for every active participant whose position changed.
async function saveOrder(order) {
  const changed = order.filter((p, k) => p.position !== k);
  const updated = await Promise.all(changed.map(p => api.updateParticipant(p.id, { position: order.indexOf(p) })));
  const byId = new Map(updated.map(u => [u.id, u]));
  current.participants = [...order.map(p => byId.get(p.id) || p), ...current.participants.filter(p => p.archived)];
}

Object.assign(actions, {
  new() {
    run(async () => {
      current = await api.createTournament({ name: 'Untitled tournament' });
      stats = null;
      runHistory = null;
      selectTitle = true;
      location.hash = tabLink('participants');
    });
  },
  open: el => { location.hash = '#/t/' + el.dataset.id; },
  delete(el) {
    const s = summaries.find(x => x.id === el.dataset.id);
    deleteTournament(s.id, s.name);
  },
  'delete-current'() {
    if (view.screen === 'tournament') deleteTournament(current.id, current.name);
    else deleteRatingList(ratingList.id, ratingList.name);
  },
  'copy-link'() {
    copyLink(view.screen === 'tournament' ? `#/t/${current.id}` : `#/r/${ratingList.id}`);
  },
  import: () => run(importOld),
  'edit-p'(el) {
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
  },
  'refresh-p'() {
    run(async () => {
      current.participants = await api.listParticipants(current.id, true);
      if (editingId && !activeOf(current).some(p => p.id === editingId)) { editingId = null; formImage = null; }
      render();
      toast('Participants reloaded from the server.');
    });
  },
  'move-p'(el) {
    const list = activeOf(current);
    const i = list.findIndex(p => p.id === el.dataset.id);
    const j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= list.length) return;
    const order = [...list];
    [order[i], order[j]] = [order[j], order[i]];
    run(async () => {
      await saveOrder(order);
      render();
    });
  },
  'remove-p'(el) {
    const id = el.dataset.id;
    run(async () => {
      await api.deleteParticipant(id);
      // Someone who played in a run is archived (kept for history), so reload
      current.participants = await api.listParticipants(current.id, true);
      if (editingId === id) { editingId = null; formImage = null; }
      stats = null;
      render();
    });
  },
  start() {
    run(async () => {
      const options = await api.runOptions(current.id);
      if (!options.length) throw new Error('Add at least 2 participants first.');
      // Preselect "everyone plays" when it needs no play-in, otherwise the biggest cut
      const preselect = options[0].play_in && options[1] ? 1 : 0;
      view.picker = { options, preselect };
      renderModal();
    });
  },
  'delete-run': el => deleteRun(el.dataset.id),
  'view-run'(el) {
    const id = el.dataset.id;
    if (historyRun?.id === id) {
      historyRun = null;
      render();
      return;
    }
    run(async () => {
      historyRun = await api.getRun(id);
      render();
    });
  },
  sort(el) {
    const key = el.dataset.key;
    statsSort = statsSort && statsSort[0] === key
      ? [key, statsSort[1] === 'asc' ? 'desc' : 'asc']
      : [key, el.dataset.dir];
    render();
  },
  'open-match'(el) {
    view.match = { r: +el.dataset.r, i: +el.dataset.i };
    renderModal();
  },
  pick(el) {
    const draft = { rounds: structuredClone(current.latest_run.rounds) };
    advance(draft, view.match.r, view.match.i, el.dataset.pid);
    run(() => saveRounds(draft.rounds));
  },
  undo() {
    const draft = { rounds: structuredClone(current.latest_run.rounds) };
    undo(draft, view.match.r, view.match.i);
    run(() => saveRounds(draft.rounds));
  },
});

// Start a run (POST /api/runs)
forms.startform = (form) => {
  const f = form.elements;
  const size = Number(f.size.value);
  if (!size) return toast('Pick a bracket size.', true);
  run(async () => {
    current.latest_run = await api.createRun({ tournament_id: current.id, size, shuffle: f.shuffle.checked });
    current.run_count += 1;
    stats = null;
    runHistory = null;
    view.picker = null;
    if (location.hash === tabLink('bracket')) render();
    else location.hash = tabLink('bracket');
  });
};

// Imports and the add form name an untitled tournament after the playlist
async function addImported(result) {
  current.participants.push(...result.added);
  if (current.name === 'Untitled tournament' && result.playlist_title) {
    const renamed = await api.updateTournament(current.id, { name: result.playlist_title.slice(0, 80) });
    current.name = renamed.name;
  }
  return result;
}

screens.tournament = {
  render: renderTournament,
  modal: () => (view.picker ? pickerHtml() : view.match ? matchHtml() : ''),
  async reload() { current = await api.getTournament(current.id); },
  async rename(name) {
    const renamed = await api.updateTournament(current.id, { name });
    current.name = renamed.name;
    return current.name;
  },
  async saveItem(id, data) {
    if (id) {
      const updated = await api.updateParticipant(id, data);
      current.participants = current.participants.map(p => p.id === updated.id ? updated : p);
    } else {
      current.participants.push(await api.createParticipant({ tournament_id: current.id, ...data }));
    }
  },
  importYoutube: async url => addImported(await api.importYoutube({ tournament_id: current.id, url })),
  importSpotify: async links => addImported(await api.importSpotify({ tournament_id: current.id, links })),
};
