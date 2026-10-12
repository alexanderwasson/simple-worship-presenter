'use strict';
/* Simple Worship Presenter — application client.
   All user-supplied text is escaped before it reaches innerHTML. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = s => esc(s).replace(/\r?\n/g, '<br>');
const pad = n => String(n).padStart(2, '0');
const bytes = n => { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB'; };
// Storage is shown in megabytes so quotas are easy to reason about; the server
// still stores exact bytes.
const MB = 1048576;
const toMB = b => Math.round(((Number(b) || 0) / MB) * 10) / 10;
const fromMB = mb => Math.max(0, Math.round((Number(mb) || 0) * MB));
const mb = b => { const v = toMB(b); return v >= 1024 ? (v / 1024).toFixed(2) + ' GB' : v + ' MB'; };

const state = {
  user: null,
  settings: {},
  presentations: [],
  programs: [],
  songs: [],
  media: [],
  deck: null,          // { id, title, slides }
  active: 0,
  undo: [],
  redo: [],
  blanked: false,
  aspect: '16:9',
  plan: null,
  query: { presentations: '', programs: '', songs: '', media: '', slides: '' }
};

// Case-insensitive match across any number of fields.
function matches(query, ...fields) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return fields.filter(Boolean).join(' ').toLowerCase().includes(q);
}

const CHANNEL = 'simple-worship-live';
const bc = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : { postMessage() {}, onmessage: null };

/* ---------------------------------------------------------------- api */
async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, opts);
  if (res.status === 204) return { ok: true };
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : {};
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    // Keep the whole payload so callers can surface diagnostic detail.
    err.body = data;
    throw err;
  }
  return data;
}

function toast(message, kind) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('error', kind === 'error');
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function status(text) { $('#saveStatus').textContent = '● ' + text; }

/* ------------------------------------------------------------ session */
async function boot() {
  try {
    const setup = await api('/setup/status');
    if (setup.needsAdmin) return showAuth('setup');
    const me = await api('/auth/me');
    await signedIn(me.user);
  } catch (err) {
    if (err.status === 401) showAuth('login');
    else showAuth('login');
  }
}

async function signedIn(user) {
  state.user = user;
  $('#avatar').textContent = (user.name || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();
  $('#accountName').textContent = user.name;
  $('#welcomeHeading').innerHTML = 'Good ' + greeting() + ', ' + esc(user.name.split(' ')[0]) + '<span class="accent-dot">.</span>';
  await Promise.all([loadPresentations(), loadPrograms(), loadSongs(), loadMedia(), loadSettings()]);
  showView('library');
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

function showAuth(mode) {
  const c = $('#modalContent');
  const isSetup = mode === 'setup';
  c.innerHTML = `
    <h2>${isSetup ? 'Create the administrator account' : 'Sign in'}</h2>
    <p>${isSetup ? 'This runs once per installation. Keep these credentials safe.' : 'Sign in to reach your workspace.'}</p>
    ${isSetup ? '' : '<div class="auth-tabs"><button id="tabLogin" class="on">Sign in</button><button id="tabRegister">Register</button></div>'}
    <input class="modal-input" id="authName" placeholder="Your name" ${isSetup ? '' : 'hidden'}>
    <input class="modal-input" id="authEmail" type="email" placeholder="Email">
    <input class="modal-input" id="authPassword" type="password" placeholder="Password (10+ characters)" autocomplete="current-password">
    <p class="auth-error" id="authError" hidden></p>
    <button class="primary-button modal-save" id="authSubmit">${isSetup ? 'Create administrator' : 'Sign in'}</button>
    <p class="legal-note">Passwords are hashed with bcrypt and never stored in plain text. Use HTTPS in production.</p>`;
  $('#modalBackdrop').classList.add('open');
  // The name field is needed for setup and registration, never for sign-in.
  const setMode = m => {
    $('#authName').hidden = (m === 'login');
    $('#authSubmit').textContent = m === 'setup' ? 'Create administrator' : m === 'register' ? 'Create account' : 'Sign in';
    if ($('#tabLogin')) {
      $('#tabLogin').classList.toggle('on', m === 'login');
      $('#tabRegister').classList.toggle('on', m === 'register');
    }
    $('#authError').hidden = true;
    showAuth.current = m;
  };
  setMode(isSetup ? 'setup' : (mode === 'register' ? 'register' : 'login'));
  if ($('#tabLogin')) {
    $('#tabLogin').onclick = () => setMode('login');
    $('#tabRegister').onclick = () => setMode('register');
  }
  $('#authSubmit').onclick = async () => {
    const mode2 = isSetup ? 'setup' : showAuth.current;
    const errorEl = $('#authError');
    const fail = message => {
      errorEl.textContent = message;
      errorEl.hidden = false;
      toast(message, 'error');
    };
    const name = $('#authName').value.trim();
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;

    if (mode2 !== 'login' && !name) return fail('Please enter your name.');
    if (!email) return fail('Please enter your email address.');
    if (mode2 !== 'login' && password.length < 10) return fail('Password must be at least 10 characters.');

    try {
      const path = mode2 === 'setup' ? '/setup/admin' : mode2 === 'register' ? '/auth/register' : '/auth/login';
      const body = mode2 === 'login' ? { email, password } : { name, email, password };
      const out = await api(path, { method: 'POST', body });
      $('#modalBackdrop').classList.remove('open');
      toast(mode2 === 'setup' ? 'Administrator account created' : 'Welcome, ' + out.user.name);
      await signedIn(out.user);
    } catch (e) {
      // Keep the dialog open so the message is readable and the form is not lost.
      fail(e.message);
    }
  };
}

/* ------------------------------------------------------------- router */
const views = { library: $('#libraryView'), songs: $('#songsView'), media: $('#mediaView'), editor: $('#editorView'), settings: $('#settingsView') };
function showView(name) {
  Object.values(views).forEach(v => v.classList.remove('active-view'));
  (views[name] || views.library).classList.add('active-view');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $('#crumbTitle').textContent = { library: 'Library', songs: 'Songs', media: 'Media', editor: state.deck ? state.deck.title : 'Editor', settings: 'Settings' }[name] || 'Library';
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------- library */
async function loadPresentations() {
  try {
    const { presentations } = await api('/presentations');
    state.presentations = presentations;
    renderLibrary();
  } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
}

function renderLibrary() {
  const grid = $('#deckGrid');
  const filtered = state.presentations.filter(p => matches(state.query.presentations, p.title, ...p.slides.map(slideText)));
  if (!filtered.length && state.presentations.length) {
    grid.innerHTML = `<div class="empty-filter">No presentations match “${esc(state.query.presentations)}”.</div>`;
  } else {
    grid.innerHTML = filtered.map((p, i) => `
    <article class="deck-card ${i === 0 ? 'featured' : ''}" data-open="${esc(p.id)}">
      <div class="deck-preview ${['preview-warm', 'preview-night', 'preview-pink'][i % 3]}">
        <span class="preview-label">${esc((p.slides[0] && slideText(p.slides[0]) || p.title).slice(0, 34))}</span>
        <span class="preview-meta">01 / ${pad(p.slides.length)}</span>
      </div>
      <div class="deck-info">
        <div><h3>${esc(p.title)}</h3><p>${p.slides.length} slides · edited ${relative(p.updated_at)}</p></div>
        <button class="more-button" data-menu="${esc(p.id)}" aria-label="Presentation actions">•••</button>
      </div>
    </article>`).join('') + `
    <button class="new-card" id="newCard"><span>＋</span><strong>Start something new</strong><small>Blank presentation</small></button>`;
  }

  $('#statsRow').innerHTML = `
    <div class="stat-card"><span class="stat-icon orange">✦</span><div><strong>${state.presentations.length}</strong><small>Presentations</small></div></div>
    <div class="stat-card"><span class="stat-icon blue">♪</span><div><strong>${state.songs.length}</strong><small>Songs</small></div></div>
    <div class="stat-card"><span class="stat-icon green">▤</span><div><strong>${mb(state.user ? state.user.used_bytes : 0)}</strong><small>of ${mb(state.user ? state.user.quota_bytes : 0)} used</small></div></div>`;

  $$('[data-open]', grid).forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-menu]')) return;
    const deck = state.presentations.find(p => p.id === el.dataset.open);
    if (deck) openDeck(deck);
  }));
  $('#newCard') && ($('#newCard').onclick = newPresentation);
  $$('[data-menu]', grid).forEach(btn => btn.onclick = e => { e.stopPropagation(); presentationMenu(btn.dataset.menu); });
}

function relative(iso) {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

function presentationMenu(id) {
  const deck = state.presentations.find(p => p.id === id);
  if (!deck) return;
  modal(`<h2>${esc(deck.title)}</h2>
    <div class="menu-list">
      <button data-act="open">Open in editor</button>
      <button data-act="present">Open in presenter</button>
      <button data-act="rename">Rename</button>
      <button data-act="duplicate">Duplicate</button>
      <button data-act="delete">Delete</button>
    </div>`);
  $$('#modalContent [data-act]').forEach(b => b.onclick = async () => {
    const act = b.dataset.act;
    closeModal();
    if (act === 'open') return openDeck(deck);
    if (act === 'present') { openDeck(deck); return openPresenter(); }
    if (act === 'rename') {
      const title = prompt('Presentation title', deck.title);
      if (!title) return;
      deck.title = title.slice(0, 200);
      await api('/presentations/' + deck.id, { method: 'PUT', body: { title: deck.title } });
      toast('Renamed');
      return loadPresentations();
    }
    if (act === 'duplicate') {
      await api('/presentations/' + deck.id + '/duplicate', { method: 'POST' });
      toast('Duplicated');
      return loadPresentations();
    }
    if (act === 'delete') {
      if (!confirm('Delete "' + deck.title + '"? This cannot be undone.')) return;
      await api('/presentations/' + deck.id, { method: 'DELETE' });
      toast('Deleted');
      return loadPresentations();
    }
  });
}

async function newPresentation() {
  const created = await api('/presentations', { method: 'POST', body: { title: 'Untitled presentation', slides: ['New slide'] } });
  await loadPresentations();
  const deck = state.presentations.find(p => p.id === created.id) || created;
  openDeck(deck);
  toast('Presentation created');
}

/* --------------------------------------------------------- service plans */
async function loadPrograms() {
  try {
    const { programs } = await api('/programs');
    state.programs = programs;
    renderPrograms();
  } catch (e) { /* unauthenticated */ }
}

function renderPrograms() {
  const grid = $('#programGrid');
  const filtered = state.programs.filter(p => matches(state.query.programs, p.title, p.date, p.notes));
  if (!state.programs.length) {
    grid.innerHTML = '<p class="empty-state">No service plans yet. Create one to group presentations for a date.</p>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-filter">No service plans match “${esc(state.query.programs)}”.</div>`;
    return;
  }
  grid.innerHTML = filtered.map(p => `
    <button class="program-card" data-program="${esc(p.id)}">
      <span class="program-date">${esc(p.date)}</span>
      <strong>${esc(p.title)}</strong>
      <small>${p.presentation_ids.length} presentation${p.presentation_ids.length === 1 ? '' : 's'} · click to manage</small>
    </button>`).join('');
  $$('[data-program]', grid).forEach(b => b.onclick = () => programEditor(state.programs.find(p => p.id === b.dataset.program)));
}

async function newProgram() {
  const title = prompt('Service plan name', 'Sunday service');
  if (!title) return;
  const date = prompt('Date (YYYY-MM-DD)', new Date().toISOString().slice(0, 10));
  if (!date) return;
  const { program } = await api('/programs', { method: 'POST', body: { title, date, presentation_ids: [] } });
  state.programs.unshift(program);
  renderPrograms();
  programEditor(program);
}

function programEditor(program) {
  state.planDraft = {
    id: program.id,
    title: program.title,
    date: program.date,
    notes: program.notes || '',
    presentation_ids: (program.presentation_ids || []).filter(id => state.presentations.some(p => p.id === id))
  };
  renderProgramEditor();
}

function renderProgramEditor() {
  const d = state.planDraft;
  const available = state.presentations.filter(p => !d.presentation_ids.includes(p.id));
  modal(`<h2>${esc(d.title)}</h2>
    <p>${esc(d.date)} · build the running order for this service</p>

    <label class="modal-label">Running order</label>
    <div class="running-order">
      ${d.presentation_ids.length ? d.presentation_ids.map((id, i) => {
        const p = state.presentations.find(x => x.id === id);
        return `<div class="order-row">
          <b>${i + 1}</b>
          <span>${esc(p ? p.title : 'Missing presentation')}</span>
          <button data-up="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>?</button>
          <button data-down="${i}" title="Move down" ${i === d.presentation_ids.length - 1 ? 'disabled' : ''}>?</button>
          <button data-remove="${i}" title="Remove from plan">?</button>
        </div>`;
      }).join('') : '<p class="empty-state">Nothing scheduled yet. Add presentations below.</p>'}
    </div>

    <label class="modal-label">Add presentations</label>
    <div class="program-choices">
      ${available.length ? available.map(p =>
        `<button class="program-choice add-item" data-add="${esc(p.id)}"><span>+</span><span>${esc(p.title)}</span></button>`).join('')
        : '<p class="empty-state">Every presentation is already in this plan.</p>'}
    </div>

    <label class="modal-label">Notes</label>
    <textarea class="modal-input" id="programNotes" rows="3">${esc(d.notes)}</textarea>

    <div class="modal-actions">
      <button class="primary-button" id="programSave">Save plan</button>
      <button class="secondary-button" id="programLaunch">Save &amp; present</button>
      <button class="secondary-button" id="programDuplicate">Duplicate</button>
      <button class="secondary-button danger" id="programDelete">Delete</button>
    </div>`);

  const sync = () => { d.notes = $('#programNotes') ? $('#programNotes').value : d.notes; };

  $$('#modalContent [data-add]').forEach(b => b.onclick = () => {
    sync();
    d.presentation_ids.push(b.dataset.add);
    renderProgramEditor();
  });
  $$('#modalContent [data-up]').forEach(b => b.onclick = () => {
    sync();
    const i = Number(b.dataset.up);
    if (i > 0) [d.presentation_ids[i - 1], d.presentation_ids[i]] = [d.presentation_ids[i], d.presentation_ids[i - 1]];
    renderProgramEditor();
  });
  $$('#modalContent [data-down]').forEach(b => b.onclick = () => {
    sync();
    const i = Number(b.dataset.down);
    if (i < d.presentation_ids.length - 1) [d.presentation_ids[i + 1], d.presentation_ids[i]] = [d.presentation_ids[i], d.presentation_ids[i + 1]];
    renderProgramEditor();
  });
  $$('#modalContent [data-remove]').forEach(b => b.onclick = () => {
    sync();
    d.presentation_ids.splice(Number(b.dataset.remove), 1);
    renderProgramEditor();
  });

  const persist = async () => {
    sync();
    const body = { title: d.title, date: d.date, notes: d.notes, presentation_ids: d.presentation_ids };
    const res = await api('/programs/' + d.id, { method: 'PUT', body });
    if (res.program) Object.assign(d, res.program);
    return d;
  };

  $('#programSave').onclick = async () => {
    await persist();
    closeModal();
    toast('Service plan saved');
    loadPrograms();
  };

  // Save and immediately drive the whole plan in the editor + audience display.
  $('#programLaunch').onclick = async () => {
    await persist();
    closeModal();
    await loadPrograms();
    await loadPresentations();
    const saved = state.programs.find(p => p.id === d.id) || d;
    launchPlan(saved);
  };

  $('#programDuplicate').onclick = async () => {
    await api('/programs/' + d.id + '/duplicate', { method: 'POST' });
    closeModal();
    toast('Plan duplicated');
    loadPrograms();
  };

  $('#programDelete').onclick = async () => {
    if (!confirm('Delete this service plan? The presentations are kept.')) return;
    await api('/programs/' + d.id, { method: 'DELETE' });
    closeModal();
    toast('Plan deleted');
    loadPrograms();
  };
}
/* ---------------------------------------------------------------- songs */
async function loadSongs() {
  try {
    const { songs } = await api('/songs');
    state.songs = songs;
    renderSongs();
  } catch (e) { /* unauthenticated */ }
}

function renderSongs() {
  const list = $('#songList');
  const filtered = state.songs.filter(s => matches(state.query.songs, s.title, s.artist, s.author, s.ccli, (s.tags || []).join(' '), ...s.sections.map(x => x.label + ' ' + x.text)));
  if (!state.songs.length) {
    list.innerHTML = '<p class="empty-state">No songs yet.</p>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-filter">No songs match “${esc(state.query.songs)}”.</div>`;
    return;
  }
  list.innerHTML = filtered.map(s => `
    <button class="song-row" data-song="${esc(s.id)}">
      <strong>${esc(s.title)}</strong>
      <small>${esc(s.artist || s.author || 'Unknown')} · ${s.sections.length} sections</small>
    </button>`).join('');
  $$('[data-song]', list).forEach(b => b.onclick = () => openSong(state.songs.find(s => s.id === b.dataset.song)));
}

function blankSong() {
  return { id: null, title: '', author: '', artist: '', copyright: '', ccli: '', tags: [], theme: {}, sections: [{ id: 's1', label: 'Verse 1', text: '' }] };
}

function openSong(song) {
  const s = song || blankSong();
  state.songDraft = JSON.parse(JSON.stringify(s));
  renderSongEditor();
}

function renderSongEditor() {
  const s = state.songDraft;
  $('#songEditor').innerHTML = `
    <div class="form-grid">
      <label>Title<input id="sTitle" value="${esc(s.title)}"></label>
      <label>Artist<input id="sArtist" value="${esc(s.artist)}"></label>
      <label>Author<input id="sAuthor" value="${esc(s.author)}"></label>
      <label>Copyright<input id="sCopyright" value="${esc(s.copyright)}"></label>
      <label>CCLI number<input id="sCcli" value="${esc(s.ccli)}"></label>
      <label>Tags<input id="sTags" value="${esc((s.tags || []).join(', '))}" placeholder="hymn, communion"></label>
    </div>
    <div class="section-head" style="margin:24px 0 12px"><div><h2>Sections</h2><p>Each section becomes its own set of slides.</p></div>
      <button class="secondary-button" id="addSection">＋ Add section</button></div>
    <div id="sectionList">${s.sections.map((sec, i) => `
      <div class="section-editor" data-index="${i}">
        <div class="section-editor-head">
          <input class="section-label" value="${esc(sec.label)}" aria-label="Section label">
          <button data-move="up" title="Move up">↑</button>
          <button data-move="down" title="Move down">↓</button>
          <button data-remove title="Remove section">⌫</button>
        </div>
        <textarea class="section-text" rows="5" placeholder="Lyrics…">${esc(sec.text)}</textarea>
      </div>`).join('')}</div>
    <div class="modal-actions" style="margin-top:18px">
      <button class="primary-button" id="songSave">Save song</button>
      <button class="secondary-button" id="songGenerate">Generate slides</button>
      ${s.id ? '<button class="secondary-button danger" id="songDelete">Delete</button>' : ''}
    </div>`;

  const readDraft = () => {
    s.title = $('#sTitle').value; s.artist = $('#sArtist').value; s.author = $('#sAuthor').value;
    s.copyright = $('#sCopyright').value; s.ccli = $('#sCcli').value;
    s.tags = $('#sTags').value.split(',').map(t => t.trim()).filter(Boolean);
    s.sections = $$('#sectionList .section-editor').map(row => ({
      id: row.dataset.id || ('sec-' + row.dataset.index),
      label: row.querySelector('.section-label').value,
      text: row.querySelector('.section-text').value
    }));
    return s;
  };

  $('#addSection').onclick = () => { readDraft(); s.sections.push({ id: 'sec-' + Date.now(), label: 'Section ' + (s.sections.length + 1), text: '' }); renderSongEditor(); };
  $$('#sectionList [data-move]').forEach(b => b.onclick = () => {
    readDraft();
    const row = b.closest('.section-editor');
    const i = Number(row.dataset.index);
    const j = b.dataset.move === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= s.sections.length) return;
    [s.sections[i], s.sections[j]] = [s.sections[j], s.sections[i]];
    renderSongEditor();
  });
  $$('#sectionList [data-remove]').forEach(b => b.onclick = () => {
    readDraft();
    s.sections.splice(Number(b.closest('.section-editor').dataset.index), 1);
    if (!s.sections.length) s.sections.push({ id: 'sec-' + Date.now(), label: 'Verse 1', text: '' });
    renderSongEditor();
  });

  $('#songSave').onclick = async () => {
    const body = readDraft();
    if (!body.title.trim()) return toast('A song title is required', 'error');
    if (body.id) {
      const { song } = await api('/songs/' + body.id, { method: 'PUT', body });
      Object.assign(body, song);
    } else {
      const { song } = await api('/songs', { method: 'POST', body });
      Object.assign(body, song);
    }
    toast('Song saved');
    loadSongs();
  };

  $('#songGenerate').onclick = async () => {
    const body = readDraft();
    if (!body.id) { await $('#songSave').onclick(); }
    if (!state.songDraft.id) return;
    const out = await api('/songs/' + state.songDraft.id + '/generate', { method: 'POST', body: { lines_per_slide: 4 } });
    const created = await api('/presentations', { method: 'POST', body: { title: out.title, slides: out.slides } });
    await loadPresentations();
    const deck = state.presentations.find(p => p.id === created.id) || created;
    openDeck(deck);
    toast(out.slides.length + ' slides generated from ' + out.title);
  };

  if ($('#songDelete')) $('#songDelete').onclick = async () => {
    if (!confirm('Delete this song?')) return;
    await api('/songs/' + s.id, { method: 'DELETE' });
    state.songDraft = null;
    $('#songEditor').innerHTML = '<p class="empty-state">Select a song to edit it.</p>';
    toast('Song deleted');
    loadSongs();
  };
}

/* ---------------------------------------------------------------- media */
async function loadMedia() {
  try {
    const { media } = await api('/media');
    state.media = media;
    renderMedia();
  } catch (e) { /* unauthenticated */ }
}

function renderMedia() {
  const grid = $('#mediaGrid');
  const filtered = state.media.filter(m => matches(state.query.media, m.original_name, m.mime, m.kind));
  if (!state.media.length) {
    grid.innerHTML = '<p class="empty-state">No media yet. Upload images, video or audio.</p>';
    return;
  }
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-filter">No media match “${esc(state.query.media)}”.</div>`;
    return;
  }
  grid.innerHTML = filtered.map(m => `
    <article class="media-card">
      <div class="media-thumb" style="background-image:url('/api/media/${esc(m.id)}/file')"><span>${esc(m.kind)}</span></div>
      <strong>${esc(m.original_name)}</strong>
      <small>${esc(m.mime)} · ${bytes(m.size)}</small>
      <div class="media-actions">
        ${m.kind === 'image' ? '<button data-bg="' + esc(m.id) + '">Set as background</button>' : ''}
        <button data-del-media="${esc(m.id)}">Delete</button>
      </div>
    </article>`).join('');
  $$('[data-bg]', grid).forEach(b => b.onclick = () => useMediaAsBackground(b.dataset.bg));
  $$('[data-del-media]', grid).forEach(b => b.onclick = async () => {
    if (!confirm('Delete this media? Presentations that reference it will fall back to their other background.')) return;
    await api('/media/' + b.dataset.delMedia, { method: 'DELETE' });
    toast('Media deleted');
    loadMedia();
    refreshUser();
  });
}

async function useMediaAsBackground(id) {
  const bg = `url("/api/media/${id}/file") center/cover no-repeat`;
  if (!state.deck) {
    await api('/settings', { method: 'PUT', body: { } }).catch(() => {});
    toast('Open a presentation to apply this background');
    return;
  }
  pushHistory();
  const slide = state.deck.slides[state.active];
  if (typeof slide === 'string') state.deck.slides[state.active] = { text: slide, background: bg };
  else slide.background = bg;
  renderEditor();
  saveDeck();
  toast('Background applied to this presentation');
}

async function uploadMedia(files) {
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    status('Uploading ' + file.name + '…');
    try {
      await api('/media', { method: 'POST', body: form });
      toast('Uploaded ' + file.name);
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  status('Ready');
  loadMedia();
  refreshUser();
}

/* --------------------------------------------------------------- editor */
function slideText(slide) {
  if (typeof slide === 'string') return slide;
  return (slide && (slide.text || slide.name)) || 'Image slide';
}
function slideImage(slide) {
  return slide && typeof slide === 'object' ? (slide.image || '') : '';
}
function slideBg(slide) {
  return slide && typeof slide === 'object' ? (slide.background || '') : '';
}

// Font choices offered in the slide editor. Each maps to a Google Fonts family
// or a reliable system family so the audience display renders identically.
const FONTS = [
  { name: 'Manrope', stack: "'Manrope', sans-serif", kind: 'sans' },
  { name: 'Inter', stack: "'Inter', sans-serif", kind: 'sans' },
  { name: 'Montserrat', stack: "'Montserrat', sans-serif", kind: 'sans' },
  { name: 'Poppins', stack: "'Poppins', sans-serif", kind: 'sans' },
  { name: 'Source Sans 3', stack: "'Source Sans 3', sans-serif", kind: 'sans' },
  { name: 'Oswald', stack: "'Oswald', sans-serif", kind: 'condensed' },
  { name: 'Bebas Neue', stack: "'Bebas Neue', sans-serif", kind: 'condensed' },
  { name: 'Georgia', stack: 'Georgia, serif', kind: 'serif' },
  { name: 'Playfair Display', stack: "'Playfair Display', serif", kind: 'serif' },
  { name: 'Lora', stack: "'Lora', serif", kind: 'serif' },
  { name: 'Merriweather', stack: "'Merriweather', serif", kind: 'serif' },
  { name: 'Libre Baskerville', stack: "'Libre Baskerville', serif", kind: 'serif' },
  { name: 'Roboto Slab', stack: "'Roboto Slab', serif", kind: 'slab' },
  { name: 'DM Mono', stack: "'DM Mono', monospace", kind: 'mono' }
];
const FONT_STACKS = Object.fromEntries(FONTS.map(f => [f.name, f.stack]));

const DEFAULT_STYLE = {
  font: 'Manrope',
  size: 62,
  weight: 600,
  color: '#ffffff',
  align: 'center',
  valign: 'center',
  lineHeight: 1.12,
  animation: 'rise'
};

const ANIMATIONS = [
  { id: 'none', name: 'None' },
  { id: 'fade', name: 'Fade' },
  { id: 'rise', name: 'Rise' },
  { id: 'blur', name: 'Blur in' },
  { id: 'scale', name: 'Scale up' },
  { id: 'words', name: 'Word by word' }
];

// Build animated HTML for a slide's text. Never called with raw markup: every
// fragment is escaped before it is wrapped in animation spans.
function animatedText(text, style) {
  const anim = (style && style.animation) || 'none';
  const raw = String(text == null ? '' : text);
  if (anim === 'none') return esc(raw).replace(/\r?\n/g, '<br>');
  if (anim !== 'words') {
    return `<span class="swp-anim-${esc(anim)}">${esc(raw).replace(/\r?\n/g, '<br>')}</span>`;
  }
  let wordIndex = 0;
  return raw.split(/\r?\n/).map(line =>
    line.split(/(\s+)/).map(token => {
      if (!token || /^\s+$/.test(token)) return token;
      const delay = (wordIndex++ * 95) + 'ms';
      return `<span class="swp-word" style="animation-delay:${delay}">${esc(token)}</span>`;
    }).join('')
  ).join('<br>');
}

function slideStyle(slide) {
  const from = slide && typeof slide === 'object' && slide.style ? slide.style : {};
  return { ...DEFAULT_STYLE, ...from };
}

// Convert a slide to an object so style can be attached without losing text.
function slideObject(slide) {
  if (typeof slide === 'string') return { text: slide };
  return slide && typeof slide === 'object' ? slide : { text: '' };
}

function applySlideStyle(style) {
  const canvas = $('#slideCanvas');
  const title = $('#canvasTitle');
  // `size` is authored against a 1280px-wide slide, then scaled to the surface.
  const scale = (canvas.clientWidth || 1280) / 1280;
  canvas.style.textAlign = style.align;
  canvas.style.justifyContent = { top: 'flex-start', center: 'center', bottom: 'flex-end' }[style.valign] || 'center';
  title.style.fontFamily = FONT_STACKS[style.font] || FONT_STACKS.Manrope;
  title.style.fontSize = Math.round((Number(style.size) || 62) * scale) + 'px';
  title.style.fontWeight = style.weight;
  title.style.color = style.color;
  title.style.lineHeight = style.lineHeight || 1.12;
  title.style.letterSpacing = /Bebas|Oswald/.test(style.font) ? '0.02em' : '-0.025em';
}

function openDeck(deck, slideIndex = 0) {
  state.deck = { id: deck.id, title: deck.title, slides: (deck.slides || []).slice() };
  state.active = Math.max(0, Math.min(slideIndex, state.deck.slides.length - 1));
  state.undo = [];
  state.redo = [];
  $('#editorTitle').textContent = deck.title;
  renderEditor();
  showView('editor');
  status(state.plan ? 'Plan: ' + state.plan.title : 'Ready');
}

/* ------------------------------------------------- service plan playback */
function launchPlan(program) {
  const items = (program.presentation_ids || [])
    .map(id => state.presentations.find(p => p.id === id))
    .filter(Boolean);
  if (!items.length) {
    toast('Add at least one presentation to this plan first', 'error');
    return;
  }
  state.plan = {
    id: program.id,
    title: program.title,
    date: program.date,
    index: 0,
    items
  };
  openDeck(items[0], 0);
  openPresenter();
  toast(`Plan “${program.title}” is live — ${items.length} item${items.length === 1 ? '' : 's'}`);
}

function planItemTitle(index) {
  return state.plan && state.plan.items[index] ? state.plan.items[index].title : '';
}

// Move between the presentations inside the active plan. Returns true if it moved.
function planAdvance(direction) {
  if (!state.plan) return false;
  const next = state.plan.index + direction;
  if (next < 0 || next >= state.plan.items.length) return false;
  state.plan.index = next;
  const deck = state.plan.items[next];
  // Entering from the front starts at slide 1; going back lands on the last slide.
  openDeck(deck, direction > 0 ? 0 : (deck.slides || []).length - 1);
  toast(direction > 0 ? 'Next in plan: ' + deck.title : 'Previous in plan: ' + deck.title);
  return true;
}

function nextSlide() {
  if (!state.deck) return;
  if (state.active < state.deck.slides.length - 1) return selectSlide(state.active + 1);
  if (planAdvance(1)) return;
  toast('End of ' + state.deck.title);
}

function prevSlide() {
  if (!state.deck) return;
  if (state.active > 0) return selectSlide(state.active - 1);
  if (planAdvance(-1)) return;
  toast('Start of ' + state.deck.title);
}

function pushHistory() {
  state.undo.push(JSON.stringify({ slides: state.deck.slides, active: state.active }));
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
}

function restore(snapshot) {
  const parsed = JSON.parse(snapshot);
  state.deck.slides = parsed.slides;
  state.active = Math.min(parsed.active, state.deck.slides.length - 1);
  renderEditor();
  saveDeck();
}

function undo() {
  if (!state.undo.length) return toast('Nothing to undo');
  state.redo.push(JSON.stringify({ slides: state.deck.slides, active: state.active }));
  restore(state.undo.pop());
}
function redo() {
  if (!state.redo.length) return toast('Nothing to redo');
  state.undo.push(JSON.stringify({ slides: state.deck.slides, active: state.active }));
  restore(state.redo.pop());
}

function renderEditor() {
  if (!state.deck) return;
  const slides = state.deck.slides;
  state.active = Math.max(0, Math.min(state.active, slides.length - 1));

  const visible = slides.map((s, i) => ({ s, i })).filter(({ s }) => matches(state.query.slides, slideText(s)));
  $('#slideList').innerHTML = visible.length ? visible.map(({ s, i }) => `
    <button class="slide-thumb ${i === state.active ? 'active' : ''} thumb-${['one', 'two', 'three', 'four'][i % 4]}" data-slide="${i}" data-num="${pad(i + 1)}">
      ${slideImage(s) ? `<img class="thumb-img" src="${esc(slideImage(s))}" alt="">` : ''}
      <span>${esc(slideText(s).slice(0, 40))}</span>
    </button>`).join('') : `<div class="empty-filter">No slides match “${esc(state.query.slides)}”.</div>`;
  $$('[data-slide]').forEach(b => b.onclick = () => selectSlide(Number(b.dataset.slide)));

  const slide = slides[state.active] || '';
  const bg = slideBg(slide) || 'linear-gradient(135deg,#b96b4d,#d59063)';
  const style = slideStyle(slide);
  $('#slideCanvas').style.background = bg;
  $('#canvasKicker').textContent = (state.deck.title + ' · ' + new Date().toLocaleDateString()).toUpperCase();
  const canvasText = slideText(slide);
  $('#canvasTitle').innerHTML = canvasText ? animatedText(canvasText, style) : '<em>New slide</em>';
  $('#canvasCount').textContent = pad(state.active + 1);
  $('#canvasFooter').textContent = state.settings.ccli_license ? 'CCLI ' + state.settings.ccli_license : (config.instanceName || 'Simple Worship Presenter');
  applySlideStyle(style);

  renderEditorActions();
  renderInspector();
  renderControlRoom();
  broadcast();
}

function renderEditorActions() {
  const bar = $('#editorActions');
  if (!bar) return;
  bar.innerHTML = `
    <button class="secondary-button" id="actUndo" title="Undo (Ctrl+Z)">↶</button>
    <button class="secondary-button" id="actRedo" title="Redo (Ctrl+Shift+Z)">↷</button>
    <button class="secondary-button" id="actPrev" title="Previous slide (←)">←</button>
    <button class="secondary-button" id="actNext" title="Next slide (Space)">→</button>
    <button class="secondary-button" id="actSave">Save</button>
    <button class="secondary-button" id="actBlank">■ Blank</button>
    <button class="primary-button" id="actPresent">▷ Present <span>↗</span></button>`;
  $('#actUndo').onclick = undo;
  $('#actRedo').onclick = redo;
  $('#actPrev').onclick = prevSlide;
  $('#actNext').onclick = nextSlide;
  $('#actSave').onclick = async () => { await saveDeck(); toast('Presentation saved'); };
  $('#actBlank').onclick = toggleBlank;
  $('#actPresent').onclick = openPresenter;
}

function renderInspector() {
  const slide = state.deck.slides[state.active];
  const style = slideStyle(slide);
  const isImage = slide && typeof slide === 'object';
  $('#inspector').innerHTML = `
    <p class="eyebrow">Slide design</p>
    <label>Slide text</label>
    <textarea id="slideEditor" rows="5" placeholder="Type slide text…">${esc(slideText(slide))}</textarea>

    <label>Font family</label>
    <select class="font-select" id="fontSelect">
      ${['sans', 'condensed', 'serif', 'slab', 'mono'].map(kind => `
        <optgroup label="${{ sans: 'Sans serif', condensed: 'Condensed', serif: 'Serif', slab: 'Slab', mono: 'Monospace' }[kind]}">
          ${FONTS.filter(f => f.kind === kind).map(f => `<option value="${esc(f.name)}" ${style.font === f.name ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
        </optgroup>`).join('')}
    </select>
    <div class="font-preview" id="fontPreview">Aa Worship</div>

    <label>Text size</label>
    <div class="control-row">
      <input type="range" id="sizeRange" min="18" max="160" step="1" value="${Number(style.size) || 62}">
      <output id="sizeOut">${Number(style.size) || 62}px</output>
    </div>

    <label>Weight</label>
    <div class="control-row">
      <button class="weight-toggle ${Number(style.weight) >= 700 ? 'active' : ''}" id="weightToggle" title="Bold">B</button>
      <div class="align-group" style="flex:1">
        <button data-align="left" class="${style.align === 'left' ? 'active' : ''}" title="Align left"><span class="align-icon"><i></i><i></i><i></i></span></button>
        <button data-align="center" class="${style.align === 'center' ? 'active' : ''}" title="Align centre"><span class="align-icon"><i></i><i></i><i></i></span></button>
        <button data-align="right" class="${style.align === 'right' ? 'active' : ''}" title="Align right"><span class="align-icon"><i></i><i></i><i></i></span></button>
      </div>
      <input class="color-input" type="color" id="colorInput" value="${/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : '#ffffff'}" title="Text colour">
    </div>

    <label>Vertical position</label>
    <div class="align-group">
      <button data-valign="top" class="${style.valign === 'top' ? 'active' : ''}">Top</button>
      <button data-valign="center" class="${style.valign === 'center' ? 'active' : ''}">Middle</button>
      <button data-valign="bottom" class="${style.valign === 'bottom' ? 'active' : ''}">Bottom</button>
    </div>

    <label>Animation</label>
    <select class="font-select" id="animSelect">
      ${ANIMATIONS.map(a => `<option value="${a.id}" ${style.animation === a.id ? 'selected' : ''}>${a.name}</option>`).join('')}
    </select>

    <label>Background</label>
    <div class="color-row">
      <button class="color active" data-theme="color"></button>
      <button class="color warm" data-theme="warm"></button>
      <button class="color blue" data-theme="blue"></button>
      <button class="color pink" data-theme="pink"></button>
      <button class="add-color" id="pickBackground" title="Upload background image">+</button>
    </div>
    <div class="inspector-divider"></div>
    <button class="delete-slide" id="deleteSlide">? Delete slide</button>
    ${isImage ? '<p class="legal-note">This slide has an image attached.</p>' : ''}`;

  const current = () => slideObject(state.deck.slides[state.active]);

  const commitStyle = (patch, { save = true } = {}) => {
    const obj = current();
    obj.style = { ...slideStyle(obj), ...patch };
    state.deck.slides[state.active] = obj;
    applySlideStyle(slideStyle(obj));
    const preview = $('#fontPreview');
    if (preview) {
      preview.style.fontFamily = FONT_STACKS[obj.style.font] || FONT_STACKS.Manrope;
      preview.style.fontWeight = obj.style.weight;
      preview.style.color = '#4d4c47';
    }
    broadcast();
    if (save) scheduleSave();
  };

  $('#slideEditor').oninput = e => {
    const value = e.target.value;
    const obj = current();
    obj.text = value;
    state.deck.slides[state.active] = obj;
    $('#canvasTitle').innerHTML = lines(value);
    const thumb = $$('[data-slide]')[state.active];
    if (thumb) thumb.querySelector('span').textContent = value.slice(0, 40);
    broadcast();
    scheduleSave();
  };

  $('#fontSelect').onchange = e => commitStyle({ font: e.target.value });
  $('#sizeRange').oninput = e => {
    const value = Number(e.target.value);
    $('#sizeOut').textContent = value + 'px';
    $('#canvasTitle').style.fontSize = value + 'px';
    commitStyle({ size: value }, { save: false });
  };
  $('#sizeRange').onchange = () => scheduleSave();
  $('#weightToggle').onclick = e => {
    const next = Number(slideStyle(current()).weight) >= 700 ? 400 : 700;
    e.currentTarget.classList.toggle('active', next === 700);
    commitStyle({ weight: next });
  };
  $('#colorInput').oninput = e => commitStyle({ color: e.target.value }, { save: false });
  $('#colorInput').onchange = () => scheduleSave();
  $$('#inspector [data-align]').forEach(b => b.onclick = () => {
    $$('#inspector [data-align]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    commitStyle({ align: b.dataset.align });
  });
  $$('#inspector [data-valign]').forEach(b => b.onclick = () => {
    $$('#inspector [data-valign]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    commitStyle({ valign: b.dataset.valign });
  });
  $('#animSelect').onchange = e => {
    commitStyle({ animation: e.target.value });
    // Re-render so the operator sees the chosen animation straight away.
    const s = slideStyle(current());
    const text = slideText(state.deck.slides[state.active]);
    $('#canvasTitle').innerHTML = text ? animatedText(text, s) : '<em>New slide</em>';
    applySlideStyle(s);
  };

  $$('#inspector [data-theme]').forEach(b => b.onclick = () => {
    $$('#inspector [data-theme]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const themes = {
      color: 'linear-gradient(135deg,#b96b4d,#d59063)',
      warm: 'linear-gradient(135deg,#d99c5d,#bd684a)',
      blue: 'linear-gradient(135deg,#18364d,#406b7d)',
      pink: 'linear-gradient(135deg,#bd6680,#70416f)'
    };
    applyBackground(themes[b.dataset.theme]);
    toast('Theme applied to this presentation');
  });

  $('#pickBackground').onclick = () => $('#backgroundInput').click();
  $('#deleteSlide').onclick = () => deleteSlide();

  // Reflect the starting style in the preview swatch.
  const preview = $('#fontPreview');
  if (preview) {
    preview.style.fontFamily = FONT_STACKS[style.font] || FONT_STACKS.Manrope;
    preview.style.fontWeight = style.weight;
    preview.style.color = '#4d4c47';
  }
}
function renderControlRoom() {
  const slides = state.deck.slides;
  const filter = ($('#mediaFilter') && $('#mediaFilter').value || '').toLowerCase();
  $('#mediaTree').innerHTML = `<div class="tree-row active">▾ <strong>${esc(state.deck.title)}</strong></div>` +
    slides.map((s, i) => ({ s, i })).filter(({ s }) => slideText(s).toLowerCase().includes(filter)).map(({ s, i }) => `
      <button class="tree-file media-slide" data-media-slide="${i}">
        <span class="mini-slide-preview ${slideImage(s) ? 'has-image' : ''}" ${slideImage(s) ? `style="background-image:url('${esc(slideImage(s))}')"` : ''}></span>
        <span>${pad(i + 1)} · ${esc(slideText(s).slice(0, 32))}</span>
      </button>`).join('');
  $$('[data-media-slide]').forEach(b => b.onclick = () => selectSlide(Number(b.dataset.mediaSlide)));

  $('#queueRows').innerHTML = slides.map((s, i) => `
    <div class="queue-row ${i === state.active ? 'live' : ''}" data-queue-slide="${i}">
      <i>${i === state.active ? '▶' : '○'}</i><b>${pad(i + 1)}</b><span>${esc(slideText(s).slice(0, 38))}</span>
      ${i === state.active ? '<small>ON SCREEN</small>' : ''}
    </div>`).join('');
  $$('[data-queue-slide]').forEach(b => b.onclick = () => selectSlide(Number(b.dataset.queueSlide)));
  $('#queueStatus').textContent = state.deck ? pad(state.active + 1) + ' / ' + pad(state.deck.slides.length) : '';

  // Running order for the active service plan.
  const planBar = $('#planBar');
  if (planBar) {
    if (state.plan) {
      planBar.innerHTML = `
        <div class="plan-bar">
          <div class="plan-bar-head">
            <span class="plan-tag">SERVICE PLAN</span>
            <strong>${esc(state.plan.title)}</strong>
            <small>${esc(state.plan.date || '')} · item ${state.plan.index + 1} of ${state.plan.items.length}</small>
          </div>
          <div class="plan-items">
            ${state.plan.items.map((p, i) => `
              <button class="plan-item ${i === state.plan.index ? 'on' : ''}" data-plan-go="${i}">
                <b>${i + 1}</b><span>${esc(p.title)}</span>${i === state.plan.index ? '<small>LIVE</small>' : ''}
              </button>`).join('')}
          </div>
          <div class="plan-nav">
            <button id="planPrev">← Previous item</button>
            <button id="planNext">Next item →</button>
            <button id="planEnd">Exit plan</button>
          </div>
        </div>`;
      $$('[data-plan-go]').forEach(b => b.onclick = () => {
        state.plan.index = Number(b.dataset.planGo);
        openDeck(state.plan.items[state.plan.index], 0);
      });
      $('#planPrev').onclick = () => planAdvance(-1);
      $('#planNext').onclick = () => planAdvance(1);
      $('#planEnd').onclick = () => {
        state.plan = null;
        renderControlRoom();
        status('Ready');
        toast('Plan closed');
      };
    } else {
      planBar.innerHTML = '';
    }
  }

  // Operator-facing preview of what is coming next.
  const upNext = $('#upNext');
  if (upNext) {
    const nextSlideIndex = state.active + 1;
    const nextInDeck = nextSlideIndex < slides.length
      ? { label: 'Next slide', value: slideText(slides[nextSlideIndex]) }
      : state.plan && state.plan.index + 1 < state.plan.items.length
        ? { label: 'Next item', value: state.plan.items[state.plan.index + 1].title }
        : null;
    upNext.innerHTML = nextInDeck
      ? `<div class="up-next"><span>${esc(nextInDeck.label)}</span><strong>${esc(String(nextInDeck.value).slice(0, 46))}</strong></div>`
      : '';
  }
}

function selectSlide(i) {
  if (!state.deck) return;
  state.active = i;
  renderEditor();
  status('Slide ' + pad(i + 1) + ' live');
}

function applyBackground(bg) {
  pushHistory();
  const current = state.deck.slides[state.active];
  if (typeof current === 'string') state.deck.slides[state.active] = { text: current, background: bg };
  else current.background = bg;
  renderEditor();
  saveDeck();
}

function addSlide(after) {
  pushHistory();
  const index = (after == null ? state.active : after) + 1;
  state.deck.slides.splice(index, 0, { text: 'New slide' });
  state.active = index;
  renderEditor();
  saveDeck();
  toast('Slide added');
}

function duplicateSlide() {
  pushHistory();
  const copy = JSON.parse(JSON.stringify(state.deck.slides[state.active]));
  state.deck.slides.splice(state.active + 1, 0, copy);
  state.active += 1;
  renderEditor();
  saveDeck();
  toast('Slide duplicated');
}

function deleteSlide() {
  if (state.deck.slides.length <= 1) return toast('A presentation needs at least one slide', 'error');
  pushHistory();
  state.deck.slides.splice(state.active, 1);
  state.active = Math.max(0, state.active - 1);
  renderEditor();
  saveDeck();
  toast('Slide deleted');
}

function moveSlide(delta) {
  const i = state.active;
  const j = i + delta;
  if (j < 0 || j >= state.deck.slides.length) return;
  pushHistory();
  const [s] = state.deck.slides.splice(i, 1);
  state.deck.slides.splice(j, 0, s);
  state.active = j;
  renderEditor();
  saveDeck();
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDeck, 700);
  status('Editing…');
}

async function saveDeck() {
  if (!state.deck) return;
  const title = $('#editorTitle').textContent.trim() || 'Untitled presentation';
  state.deck.title = title;
  try {
    await api('/presentations/' + state.deck.id, { method: 'PUT', body: { title, slides: state.deck.slides } });
    status('Saved just now');
  } catch (e) {
    status('Save failed');
    toast('Could not save: ' + e.message, 'error');
  }
}

/* ---------------------------------------------- live link (server state) */
// The workspace, the audience display and any paired phones all converge on the
// same state on the server. Locally we still use BroadcastChannel for instant
// same-device feedback, but the server is authoritative when a remote is in use.
const LiveLink = {
  socket: null,
  ready: false,
  publishTimer: null,
  lastSent: '',

  payload() {
    return {
      slides: state.deck ? state.deck.slides : [],
      title: state.deck ? state.deck.title : '',
      footer: state.settings.ccli_license ? 'CCLI ' + state.settings.ccli_license : (config.instanceName || 'Simple Worship Presenter'),
      presentation_id: state.deck ? state.deck.id : null,
      index: state.active,
      blank: state.blanked,
      // When a service plan is live the phone can walk the whole running order.
      plan: state.plan ? {
        id: state.plan.id,
        title: state.plan.title,
        date: state.plan.date,
        items: state.plan.items.map(p => ({ id: p.id, title: p.title, slides: p.slides }))
      } : null,
      plan_index: state.plan ? state.plan.index : 0
    };
  },

  connect() {
    if (this.socket && this.socket.readyState <= 1) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.socket = new WebSocket(proto + '//' + location.host + '/api/remote/ws');
    } catch { return; }

    this.socket.onopen = () => {
      this.ready = true;
      this.socket.send(JSON.stringify({ type: 'auth', kind: 'display' }));
      this.publish();
    };
    this.socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'state') this.adopt(message.state, message.slide);
    };
    this.socket.onclose = () => {
      this.ready = false;
      // Reconnect quietly; the workspace keeps working locally meanwhile.
      setTimeout(() => this.connect(), 2500);
    };
    this.socket.onerror = () => { };
  },

  // Send the authoritative view of what this workspace is showing.
  publish() {
    const body = this.payload();
    const serialised = JSON.stringify(body);
    if (serialised === this.lastSent) return;
    this.lastSent = serialised;

    if (this.socket && this.socket.readyState === 1) {
      try { this.socket.send(JSON.stringify({ type: 'publish', ...body })); return; } catch { }
    }
    clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      fetch('/api/remote/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serialised
      }).catch(() => { });
    }, 120);
  },

  // A remote moved the service on: follow it rather than fighting it.
  adopt(next, slide) {
    if (!next) return;
    if (typeof next.blank === 'boolean' && next.blank !== state.blanked) {
      state.blanked = next.blank;
    }
    if (state.deck && typeof next.index === 'number' && next.index !== state.active) {
      state.active = Math.max(0, Math.min(next.index, state.deck.slides.length - 1));
      renderEditor();
    }
    if (next.title && state.deck && next.title !== state.deck.title) {
      // Titles are owned by the editor; ignore echoes of our own value.
    }
    status(next.blank ? 'Output blanked' : 'Slide ' + pad(next.index + 1) + ' live');
  },

  command(action, index) {
    const message = { type: 'command', action };
    if (action === 'goto') message.index = index;
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(message));
    } else {
      fetch('/api/remote/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, index })
      }).catch(() => { });
    }
  }
};

// ---- mobile remote dialog -----------------------------------------------
async function openRemoteDialog() {
  modal(`
    <h2>Connect Mobile Remote</h2>
    <p>Open <strong>${esc(location.origin + '/remote')}</strong> on your phone, then scan the code or type it in.</p>
    <div class="pairing-panel">
      <div class="pairing-qr"><img id="pairQr" alt="Pairing code QR" hidden><div id="pairQrLoading" class="legal-note">Generating code…</div></div>
      <div class="pairing-code">
        <span class="legal-note">Pairing code</span>
        <strong id="pairCode">————</strong>
        <small id="pairExpiry">expires shortly</small>
        <button class="secondary-button" id="pairRefresh">New code</button>
      </div>
    </div>
    <h3>Connected devices</h3>
    <div id="remoteDevices" class="device-list"><p class="legal-note">No devices connected.</p></div>
    <div class="modal-actions">
      <button class="secondary-button danger" id="revokeAll">Disconnect all</button>
      <button class="secondary-button" id="closePairing">Done</button>
    </div>
    <p class="legal-note">The QR code contains only a short-lived pairing code, never an account token. Access can be revoked here at any time.</p>
  `);

  $('#closePairing').onclick = closeModal;
  $('#pairRefresh').onclick = createPairing;
  $('#revokeAll').onclick = async () => {
    await api('/remote/devices', { method: 'DELETE' }).catch(() => { });
    loadDevices();
    toast('All remote devices disconnected');
  };

  await createPairing();
  await loadDevices();
}

async function createPairing() {
  const loading = $('#pairQrLoading');
  const qr = $('#pairQr');
  const refresh = $('#pairRefresh');
  if (loading) loading.hidden = false;
  if (qr) qr.hidden = true;
  try {
    const data = await api('/remote/pairing', { method: 'POST', body: {} });
    $('#pairCode').textContent = data.code;
    $('#pairExpiry').textContent = 'expires in ' + Math.round(data.expires_in_seconds / 60) + ' minutes';
    if (data.qr) {
      qr.src = data.qr;
      qr.hidden = false;
      loading.hidden = true;
    } else if (loading) {
      loading.textContent = 'Scan unavailable — type the code instead.';
    }
    startCooldown(data.cooldown_seconds || 0);
  } catch (e) {
    // 429 means the cooldown is running: show the remaining wait rather than an error.
    const wait = (e.body && e.body.retry_after_seconds) || 0;
    if (e.status === 429 && wait) {
      if (loading) {
        loading.hidden = false;
        loading.textContent = 'A new code can be requested in ' + wait + ' second' + (wait === 1 ? '' : 's') + '.';
      }
      startCooldown(wait);
      return;
    }
    if (loading) loading.textContent = e.message;
    if (refresh) refresh.disabled = false;
  }
}

let cooldownTimer = null;
function startCooldown(seconds) {
  const refresh = $('#pairRefresh');
  if (!refresh) return;
  clearInterval(cooldownTimer);
  let remaining = Math.ceil(seconds || 0);
  if (remaining <= 0) {
    refresh.disabled = false;
    refresh.textContent = 'New code';
    return;
  }
  refresh.disabled = true;
  refresh.textContent = 'New code in ' + remaining + 's';
  cooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      refresh.disabled = false;
      refresh.textContent = 'New code';
      return;
    }
    refresh.textContent = 'New code in ' + remaining + 's';
  }, 1000);
}

async function loadDevices() {
  const host = $('#remoteDevices');
  if (!host) return;
  try {
    const data = await api('/remote/devices');
    if (!data.remotes.length) {
      host.innerHTML = '<p class="legal-note">No devices connected.</p>';
      return;
    }
    host.innerHTML = data.remotes.map(r => `
      <div class="device-row">
        <span class="dot-on"></span>
        <div><strong>Paired device</strong><small>last seen ${relative(r.last_seen)}</small></div>
        <button class="secondary-button danger" data-revoke="${esc(r.id)}">Revoke</button>
      </div>`).join('');
    $$('[data-revoke]', host).forEach(b => b.onclick = async () => {
      await api('/remote/devices/' + b.dataset.revoke, { method: 'DELETE' }).catch(() => { });
      loadDevices();
      toast('Device disconnected');
    });
  } catch (e) {
    host.innerHTML = `<p class="legal-note">${esc(e.message)}</p>`;
  }
}

/* ----------------------------------------------------------- presenter */
function payload() {
  const slide = state.deck ? state.deck.slides[state.active] : '';
  return {
    type: 'slide',
    index: state.active,
    title: slideText(slide),
    image: slideImage(slide),
    count: state.deck ? state.deck.slides.length : 0,
    background: slideBg(slide),
    style: slideStyle(slide),
    kicker: (state.deck ? state.deck.title : '').toUpperCase(),
    footer: state.settings.ccli_license ? 'CCLI ' + state.settings.ccli_license : (config.instanceName || 'Simple Worship Presenter')
  };
}

function broadcast() {
  const msg = payload();
  try { localStorage.setItem('swp-live', JSON.stringify(msg)); } catch { /* quota */ }
  bc.postMessage(msg);
  // The server holds the authoritative state so a phone can drive it too.
  LiveLink.publish();
}

function openPresenter() {
  const win = window.open('/presenter', 'swp-presenter', 'popup,width=1280,height=720');
  if (!win) return toast('Allow pop-ups to open the audience display', 'error');
  setTimeout(broadcast, 250);
  setTimeout(broadcast, 900);
  toast('Audience display opened');
}

function toggleBlank() {
  state.blanked = !state.blanked;
  bc.postMessage({ type: state.blanked ? 'blank' : 'unblank' });
  try { localStorage.setItem('swp-live-command', JSON.stringify({ type: state.blanked ? 'blank' : 'unblank', at: Date.now() })); } catch { }
  LiveLink.publish();
  toast(state.blanked ? 'Audience display blanked' : 'Audience display restored');
}

bc.onmessage = e => { if (e.data && e.data.type === 'presenter-ready') broadcast(); };

/* ------------------------------------------------------------- settings */
async function loadSettings() {
  try {
    state.settings = await api('/settings');
    renderSettings();
  } catch (e) { /* unauthenticated */ }
}

async function refreshUser() {
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    $('#accountQuota').textContent = mb(user.used_bytes) + ' of ' + mb(user.quota_bytes);
  } catch { }
}

function renderSettings() {
  const s = state.settings;
  const pct = s.quota_bytes ? Math.min(100, Math.round((s.used_bytes / s.quota_bytes) * 100)) : 0;
  $('#accountQuota').textContent = mb(s.used_bytes) + ' of ' + mb(s.quota_bytes);
  $('#settingsPanel').innerHTML = `
    <div class="setting"><div><strong>Display name</strong><small>Shown on this device</small></div><input id="setName" value="${esc(state.user ? state.user.name : '')}"></div>
    <div class="setting"><div><strong>Storage</strong><small>${mb(s.used_bytes)} used of ${mb(s.quota_bytes)} included</small>
      ${s.storage ? `<span class="storage-breakdown">Media ${mb(s.storage.media)} · Presentations ${mb(s.storage.presentations)} · Songs ${mb(s.storage.songs)} · Plans ${mb(s.storage.programs)}</span>` : ''}</div>
      <div class="quota-bar"><i style="width:${pct}%"></i></div></div>
    <div class="setting"><div><strong>CCLI licence</strong><small>Shown in the presentation footer</small></div>
      <div class="inline-controls"><input id="setCcli" value="${esc(s.ccli_license || '')}" placeholder="e.g. 1234567"><button class="secondary-button" id="saveCcli">Save</button></div></div>
    <div class="setting"><div><strong>Change password</strong><small>Update the password for this account</small></div>
      <div class="inline-controls"><input id="curPass" type="password" placeholder="Current"><input id="newPass" type="password" placeholder="New (10+)"><button class="secondary-button" id="savePass">Update</button></div></div>
    <div class="setting"><div><strong>Sign out</strong><small>End this session on this browser</small></div><button class="secondary-button" id="logoutBtn">Sign out</button></div>
    <div class="setting"><div><strong>Delete account</strong><small>Permanently removes your data and releases your storage</small></div><button class="secondary-button danger" id="deleteAccount">Delete account</button></div>`;

  $('#saveCcli').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { ccli_license: $('#setCcli').value } });
    await loadSettings();
    toast('CCLI licence saved');
  };
  $('#savePass').onclick = async () => {
    try {
      await api('/account/password', { method: 'POST', body: { current_password: $('#curPass').value, new_password: $('#newPass').value } });
      $('#curPass').value = $('#newPass').value = '';
      toast('Password updated');
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#logoutBtn').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  };
  $('#deleteAccount').onclick = async () => {
    const password = prompt('Enter your password to permanently delete this account');
    if (!password) return;
    try {
      await api('/account', { method: 'DELETE', body: { password } });
      toast('Account deleted');
      setTimeout(() => location.reload(), 800);
    } catch (e) { toast(e.message, 'error'); }
  };

  renderAdminPanel();
}

/* --------------------------------------------------------------- admin */
let adminUsers = [];
let adminDefaultQuota = 0;

async function renderAdminPanel() {
  const host = $('#adminPanel');
  if (!host) return;
  if (!state.user || state.user.role !== 'admin') {
    host.innerHTML = '';
    return;
  }
  try {
    const data = await api('/admin/users');
    adminUsers = data.users;
    adminDefaultQuota = data.default_quota_bytes;
  } catch (e) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = `
    <div class="admin-head">
      <div><p class="eyebrow">Administrator</p><h2>Users &amp; storage</h2>
        <p class="subtitle">Create accounts, set storage allowances and remove access. Quotas are shown in megabytes.</p></div>
    </div>

    <div class="settings-panel">
      <div class="setting">
        <div><strong>Default quota for new accounts</strong><small>Applied when an account is created</small></div>
        <div class="inline-controls">
          <input id="adminDefaultQuota" type="number" min="0" step="1" value="${toMB(adminDefaultQuota)}" title="Megabytes">
          <span class="unit-label">MB</span>
          <button class="secondary-button" id="saveDefaultQuota">Save</button>
        </div>
      </div>
    </div>

    <div class="admin-create settings-panel">
      <div class="setting">
        <div><strong>Create an account</strong><small>The user can sign in straight away</small></div>
      </div>
      <div class="setting admin-create-form">
        <input id="newUserName" placeholder="Name">
        <input id="newUserEmail" type="email" placeholder="Email">
        <input id="newUserPassword" type="password" placeholder="Password (10+)">
        <span class="quota-field"><input id="newUserQuota" type="number" min="0" step="1" value="${toMB(adminDefaultQuota)}" title="Storage quota"><span class="unit-label">MB</span></span>
        <button class="primary-button" id="createUser">Create account</button>
      </div>
    </div>

    <div class="user-table">
      <div class="user-row user-row-head">
        <span>Name</span><span>Email</span><span>Role</span><span>Storage</span><span>Quota (MB)</span><span></span>
      </div>
      ${adminUsers.map(u => `
        <div class="user-row" data-user="${esc(u.id)}">
          <span class="u-name">${esc(u.name)}${u.id === state.user.id ? ' <em>(you)</em>' : ''}</span>
          <span class="u-email">${esc(u.email)}</span>
          <span><select class="u-role" ${u.id === state.user.id ? 'disabled' : ''}>
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select></span>
          <span class="u-used">${mb(u.used_bytes)}</span>
          <span><input class="u-quota" type="number" min="0" step="1" value="${toMB(u.quota_bytes)}"></span>
          <span class="u-actions">
            <button class="u-save">Save</button>
            <button class="u-delete" ${u.id === state.user.id ? 'disabled' : ''}>Delete</button>
          </span>
        </div>`).join('')}
    </div>
    <p class="legal-note">Quotas are in megabytes (${toMB(262144000)} MB = 250 MB). Deleting an account removes its presentations, plans, songs and media.</p>

    <div class="admin-head">
      <div><p class="eyebrow">Maintenance</p><h2>Instance &amp; updates</h2>
        <p class="subtitle">Version information, backups and self-update.</p></div>
    </div>
    <div class="settings-panel" id="updatePanel">
      <div class="setting"><div><strong>Current version</strong><small>Simple Worship Presenter</small></div><span class="version-pill" id="verCurrent">…</span></div>
      <div class="setting"><div><strong>Runtime</strong><small>Node.js and data schema</small></div><span class="mono-label" id="verRuntime">…</span></div>
      <div class="setting"><div><strong>Check for updates</strong><small id="updateCheckHint">Compares this install against your configured update source</small></div>
        <button class="secondary-button" id="checkUpdates">Check now</button></div>
      <div class="setting"><div><strong>Run update</strong><small id="updateRunHint">Runs the operator-configured update command</small></div>
        <button class="secondary-button" id="runUpdate">Run update</button></div>
      <div class="setting"><div><strong>Backup</strong><small>Download the account, presentation, plan and song database</small></div>
        <button class="secondary-button" id="downloadBackup">Download backup</button></div>
      <div class="update-output" id="updateOutput" hidden></div>
    </div>`;

  $('#saveDefaultQuota').onclick = async () => {
    try {
      await api('/admin/instance', { method: 'PUT', body: { default_quota_bytes: fromMB($('#adminDefaultQuota').value) } });
      toast('Default quota updated');
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#createUser').onclick = async () => {
    try {
      const created = await api('/admin/users', {
        method: 'POST',
        body: {
          name: $('#newUserName').value,
          email: $('#newUserEmail').value,
          password: $('#newUserPassword').value,
          quota_bytes: fromMB($('#newUserQuota').value)
        }
      });
      toast('Created ' + created.user.name);
      await refreshUser();
      renderAdminPanel();
    } catch (e) { toast(e.message, 'error'); }
  };

  $$('#adminPanel .user-row[data-user]').forEach(row => {
    const id = row.dataset.user;
    row.querySelector('.u-save').onclick = async () => {
      try {
        await api('/admin/users/' + id, {
          method: 'PUT',
          body: {
            quota_bytes: fromMB(row.querySelector('.u-quota').value),
            role: row.querySelector('.u-role').value
          }
        });
        toast('Account updated');
        renderAdminPanel();
      } catch (e) { toast(e.message, 'error'); }
    };
    row.querySelector('.u-delete').onclick = async () => {
      const user = adminUsers.find(u => u.id === id);
      if (!confirm(`Delete ${user.name} and all of their content? This cannot be undone.`)) return;
      try {
        await api('/admin/users/' + id, { method: 'DELETE' });
        toast('Account deleted');
        renderAdminPanel();
      } catch (e) { toast(e.message, 'error'); }
    };
  });

  wireUpdatePanel();
}

async function wireUpdatePanel() {
  const output = $('#updateOutput');
  const show = html => { output.innerHTML = html; output.hidden = false; };

  const paint = info => {
    $('#verCurrent').textContent = 'v' + info.current_version;
    $('#verRuntime').textContent = `Node ${info.node_version} · schema ${info.schema_version} · up ${Math.round(info.uptime_seconds / 60)}m`;
    $('#updateCheckHint').textContent = info.check_configured
      ? 'Source: ' + info.check_url
      : 'Disabled — set UPDATE_CHECK_URL in .env to enable';
    let runHint = info.command_configured
      ? 'Command: ' + info.update_command + (info.update_command_source === 'environment' ? '  (set in .env)' : '  (built-in default)')
      : 'Disabled — set UPDATE_COMMAND in .env to enable';
    if (info.command_configured && info.auto_restart) {
      runHint += ' — the service restarts itself afterwards';
    }
    const missing = Object.entries(info.commands || {}).filter(([, ok]) => !ok).map(([name]) => name);
    if (missing.length) {
      runHint += ` — ⚠ ${missing.join(' and ')} not found on PATH, so this will fail`;
    }
    $('#updateRunHint').textContent = runHint;
    $('#checkUpdates').disabled = !info.check_configured;
    $('#runUpdate').disabled = !info.command_configured;
    return info;
  };

  let updateCommand = '';
  try {
    const info = paint(await api('/admin/update'));
    updateCommand = info.update_command || '';
  } catch (e) {
    show(`<p class="legal-note">Could not load update information: ${esc(e.message)}</p>`);
    return;
  }

  $('#checkUpdates').onclick = async () => {
    show('<p class="legal-note">Checking…</p>');
    try {
      const r = await api('/admin/update/check', { method: 'POST' });
      show(r.update_available
        ? `<p><strong>Update available:</strong> v${esc(r.latest_version)} (you have v${esc(r.current_version)}).</p>${r.notes ? `<p class="legal-note">${esc(r.notes)}</p>` : ''}`
        : `<p><strong>Up to date.</strong> You are running v${esc(r.current_version)}.</p>`);
    } catch (e) { show(`<p class="legal-note">${esc(e.message)}</p>`); }
  };

  $('#runUpdate').onclick = async () => {
    if (!confirm('Run the update command now? The service may restart briefly.')) return;
    show('<p class="legal-note">Running update… this can take a few minutes.</p>');
    try {
      const r = await api('/admin/update/run', { method: 'POST', body: { confirm: true } });
      const run = r.run || {};
      show(`<p><strong>Update finished.</strong> Exit code ${run.exit_code}.</p>
        ${run.stdout ? `<pre class="update-log">${esc(run.stdout)}</pre>` : ''}
        ${run.stderr ? `<pre class="update-log">${esc(run.stderr)}</pre>` : ''}
        ${run.restarting
          ? `<p class="restart-notice"><strong>Restarting the service</strong> to activate the new version. This page will reload in a moment.</p>`
          : `<p class="restart-notice"><strong>Restart required.</strong> The new code is installed but not running yet.
             Restart the service — <code>pm2 restart simple-worship-presenter</code> — then reload this page.</p>`}`);
      if (run.restarting) {
        setTimeout(() => location.reload(), 5000);
      }
    } catch (e) {
      const run = e.body && e.body.run;
      show(`<p><strong>Update failed.</strong> ${esc(e.message)}</p>
        ${run && run.exit_code !== undefined ? `<p class="legal-note">Exit code ${esc(run.exit_code)}${run.signal ? ' (killed by ' + esc(run.signal) + ')' : ''}.</p>` : ''}
        ${run && run.stderr ? `<pre class="update-log">${esc(String(run.stderr).trim())}</pre>` : ''}
        ${run && run.stdout ? `<pre class="update-log">${esc(String(run.stdout).trim())}</pre>` : ''}
        <p class="restart-notice">Run the same command yourself to see the full output:<br><code>${esc(updateCommand)}</code></p>`);
    }
  };

  $('#downloadBackup').onclick = async () => {
    try {
      const res = await fetch('/api/admin/backup');
      if (!res.ok) throw new Error('Backup failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `swp-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast('Backup downloaded');
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ------------------------------------------------------------- bible */
const Bible = {
  translation: 'WEB',
  books: [],
  book: null,
  chapter: null,
  selection: new Map(),   // "book:chapter:verse" -> verse object
  passage: null,

  async init() {
    try {
      const t = await api('/bible/translations');
      const select = $('#bibleTranslation');
      select.innerHTML = t.translations.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
      if (t.translations.length) this.translation = t.translations[0].id;
      await this.loadBooks();
    } catch (e) {
      $('#bibleBookList').innerHTML = `<div class="empty-state">${esc(e.message)}<br><br>Run <code>npm run import:bible</code> on the server.</div>`;
    }
  },

  async loadBooks() {
    const data = await api('/bible/books?translation=' + encodeURIComponent(this.translation));
    this.books = data.books;
    this.renderBooks();
  },

  renderBooks() {
    const filter = ($('#bibleBookFilter')?.value || '').toLowerCase();
    const shown = this.books.filter(b => b.name.toLowerCase().includes(filter));
    let html = '';
    let testament = '';
    for (const book of shown) {
      if (book.testament !== testament) {
        testament = book.testament;
        html += `<div class="bible-testament">${testament === 'OT' ? 'Old Testament' : 'New Testament'}</div>`;
      }
      html += `<button class="bible-book-btn ${this.book === book.id ? 'on' : ''}" data-book="${esc(book.id)}">
        <span>${esc(book.name)}</span><small>${book.chapter_count}</small></button>`;
    }
    $('#bibleBookList').innerHTML = html || '<p class="empty-state">No books match.</p>';
    $$('#bibleBookList [data-book]').forEach(b => b.onclick = () => this.openChapter(b.dataset.book, 1));
  },

  async openChapter(bookId, number) {
    this.book = bookId;
    this.chapter = number;
    this.renderBooks();
    $('#bibleChapterTitle').textContent = 'Loading…';
    try {
      const data = await api(`/bible/chapter?translation=${encodeURIComponent(this.translation)}&book=${bookId}&chapter=${number}`);
      $('#bibleChapterTitle').textContent = data.book_name + ' ' + number;
      $('#bibleChapterMeta').textContent = `${esc(data.verse_count)} verses · ${esc(this.translation)}`;
      $('#bibleChapterHeading').textContent = data.heading || '';
      $('#bibleVerses').innerHTML = data.verses.map(v => `
        <div class="bible-verse ${this.selection.has(bookId + ':' + v.verse) ? 'on' : ''}" data-v="${v.verse}" tabindex="0" role="button">
          <span class="num">${v.verse}</span><span>${lines(v.text)}</span>
        </div>`).join('');
      $$('#bibleVerses .bible-verse').forEach(el => {
        el.onclick = () => this.toggleVerse(bookId, data.book_name, number, Number(el.dataset.v), el.textContent.replace(/^\s*\d+\s*/, ''));
        el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
      });
    } catch (e) {
      $('#bibleChapterTitle').textContent = data ? data.book_name : bookId;
      $('#bibleVerses').innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    }
  },

  toggleVerse(bookId, bookName, chapter, verse, text) {
    const key = bookId + ':' + chapter + ':' + verse;
    if (this.selection.has(key)) this.selection.delete(key);
    else this.selection.set(key, { book: bookId, book_name: bookName, chapter, verse, text: text.trim() });
    const el = $$('#bibleVerses .bible-verse').find(x => Number(x.dataset.v) === verse);
    if (el) el.classList.toggle('on', this.selection.has(key));
    this.renderSelection();
  },

  clearSelection() {
    this.selection.clear();
    $$('#bibleVerses .bible-verse').forEach(x => x.classList.remove('on'));
    this.renderSelection();
  },

  renderSelection() {
    const host = $('#bibleSelection');
    const items = [...this.selection.entries()].map(([, v]) => v).sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
    if (!items.length) {
      host.innerHTML = '<p class="empty-state">Click verses to select them.</p>';
      return;
    }
    const ref = items.length === 1
      ? `${items[0].book_name} ${items[0].chapter}:${items[0].verse}`
      : items[0].book_name + ' ' + items[0].chapter + ':' + items[0].verse + '–' + items[items.length - 1].chapter + ':' + items[items.length - 1].verse;
    host.innerHTML = `
      <div class="sel-count">${items.length} verse${items.length === 1 ? '' : 's'} · ${esc(ref)}</div>
      <textarea readonly>${esc(items.map(v => v.verse + ' ' + v.text).join('\n'))}</textarea>
      <div class="modal-actions">
        <button class="primary-button" id="bibleMakeSlides">Make slides</button>
        <button class="secondary-button" id="bibleClear">Clear</button>
      </div>`;
    $('#bibleClear').onclick = () => this.clearSelection();
    $('#bibleMakeSlides').onclick = () => this.makeSlides(items, ref);
  },

  // Build slides from a contiguous selection using the server generator.
  async makeSlides(items, ref) {
    const first = items[0];
    const last = items[items.length - 1];
    const isRange = items.length > 1 && items.every((v, i) => i === 0 || v.chapter * 1000 + v.verse === items[i - 1].chapter * 1000 + items[i - 1].verse + 1);
    try {
      const refString = isRange
        ? `${first.book_name} ${first.chapter}:${first.verse}-${last.chapter}:${last.verse}`
        : items.map(v => `${v.book_name} ${v.chapter}:${v.verse}`).join(', ');
      const target = isRange ? refString : `${first.book_name} ${first.chapter}:${first.verse}-${last.verse}`;
      const result = await api('/bible/slides', {
        method: 'POST',
        body: {
          ref: target,
          translation: this.translation,
          options: { lines_per_slide: 4, show_verse_numbers: true, show_reference: true, show_translation: true }
        }
      });
      this.openBuildDialog(result);
    } catch (e) {
      toast(e.message, 'error');
    }
  },

  openBuildDialog(result) {
    modal(`
      <h2>Build slides</h2>
      <p>${esc(result.reference)} · ${esc(result.translation_name)} · ${result.verse_count} verses in ${result.slide_count} slides</p>
      <div class="bible-preview">${result.slides.map(s => `<div class="bible-preview-slide"><b>${esc(s.meta)}</b><span>${lines(s.text)}</span></div>`).join('')}</div>
      <div class="modal-actions">
        <button class="primary-button" id="bibleNewDeck">New presentation</button>
        <button class="secondary-button" id="bibleAddDeck">Add to current</button>
        <button class="secondary-button" id="bibleCancel">Cancel</button>
      </div>`);
    $('#bibleCancel').onclick = closeModal;
    $('#bibleNewDeck').onclick = async () => {
      const created = await api('/presentations', {
        method: 'POST',
        body: { title: result.reference, slides: result.slides.map(s => ({ text: s.text, meta: s.meta, reference: s.reference, translation: s.translation })) }
      });
      closeModal();
      await loadPresentations();
      openDeck(state.presentations.find(p => p.id === created.id) || created);
      toast(result.slide_count + ' slides created');
    };
    $('#bibleAddDeck').onclick = async () => {
      if (!state.deck) { toast('Open a presentation first', 'error'); return; }
      pushHistory();
      state.deck.slides.push(...result.slides.map(s => ({ text: s.text, meta: s.meta, reference: s.reference, translation: s.translation })));
      renderEditor();
      await saveDeck();
      closeModal();
      toast(result.slide_count + ' slides added');
    };
  },

  async findReference(value) {
    const error = $('#bibleRefError');
    error.textContent = '';
    try {
      const result = await api('/bible/passage?translation=' + encodeURIComponent(this.translation) + '&ref=' + encodeURIComponent(value));
      if (result.error) { error.textContent = result.error; return; }
      this.openChapter(result.verses[0].book, result.verses[0].chapter);
      toast(result.reference);
    } catch (e) {
      error.textContent = e.message;
    }
  },

  async findWords(value) {
    const host = $('#bibleSearchResults');
    if (!value.trim()) { host.innerHTML = ''; return; }
    host.innerHTML = '<p class="legal-note">Searching…</p>';
    try {
      const result = await api('/bible/search?translation=' + encodeURIComponent(this.translation) + '&q=' + encodeURIComponent(value) + '&limit=40');
      if (result.error) { host.innerHTML = `<p class="legal-note">${esc(result.error)}</p>`; return; }
      if (!result.results.length) { host.innerHTML = '<p class="empty-state">No matches.</p>'; return; }
      host.innerHTML = result.results.map(r => `
        <button class="bible-result" data-b="${esc(r.book)}" data-c="${r.chapter}">
          <strong>${esc(r.reference)}</strong><span>${lines(r.text)}</span>
        </button>`).join('');
      $$('#bibleSearchResults .bible-result').forEach(b => b.onclick = () => this.openChapter(b.dataset.b, Number(b.dataset.c)));
    } catch (e) {
      host.innerHTML = `<p class="legal-note">${esc(e.message)}</p>`;
    }
  }
};
/* --------------------------------------------------------------- menus */
const MENUS = {
  File: [
    ['New presentation', () => newPresentation()],
    ['Save', () => saveDeck()],
    ['Import text file', () => $('#importInput').click()],
    ['Sign out', () => api('/auth/logout', { method: 'POST' }).then(() => location.reload())]
  ],
  Edit: [
    ['Undo', () => undo()],
    ['Redo', () => redo()],
    ['Duplicate slide', () => duplicateSlide()],
    ['Delete slide', () => deleteSlide()]
  ],
  View: [
    ['Library', () => showView('library')],
    ['Editor', () => state.deck ? showView('editor') : toast('Open a presentation first')],
    ['Audience display', () => openPresenter()]
  ],
  Slide: [
    ['Add slide', () => addSlide()],
    ['Move slide up', () => moveSlide(-1)],
    ['Move slide down', () => moveSlide(1)],
    ['Toggle aspect ratio', () => toggleAspect()]
  ],
  Media: [
    ['Upload media', () => $('#mediaUpload').click()],
    ['Add image slide', () => $('#backgroundInput').click()],
    ['Media library', () => showView('media')]
  ],
  Tools: [
    ['Connect Mobile Remote', () => openRemoteDialog()],
    ['Song library', () => showView('songs')],
    ['New service plan', () => newProgram()],
    ['Blank audience display', () => toggleBlank()]
  ],
  Settings: [
    ['Account & storage', () => showView('settings')]
  ],
  Help: [
    ['Keyboard shortcuts', () => openModal('shortcuts')],
    ['About & legal', () => openModal('about')]
  ]
};

function toggleAspect() {
  state.aspect = state.aspect === '16:9' ? '4:3' : '16:9';
  $('#aspectLabel').textContent = state.aspect;
  $('#slideCanvas').style.aspectRatio = state.aspect;
  toast('Canvas set to ' + state.aspect);
}

function mountMenus() {
  $$('#controlMenu > span').forEach(item => {
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const menu = document.createElement('div');
    menu.className = 'menu-dropdown';
    (MENUS[item.textContent] || []).forEach(([label, action]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = e => { e.stopPropagation(); menu.classList.remove('open'); action(); };
      menu.appendChild(b);
    });
    item.appendChild(menu);
    item.onclick = e => {
      e.stopPropagation();
      $$('.menu-dropdown').forEach(m => m.classList.remove('open'));
      menu.classList.toggle('open');
    };
    item.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); } };
  });
  document.addEventListener('click', () => $$('.menu-dropdown').forEach(m => m.classList.remove('open')));
}

/* --------------------------------------------------------------- modals */
function modal(html) {
  $('#modalContent').innerHTML = html;
  $('#modalBackdrop').classList.add('open');
}
function closeModal() { $('#modalBackdrop').classList.remove('open'); }

function openModal(kind) {
  if (kind === 'shortcuts') {
    modal(`<h2>Keyboard shortcuts</h2>
      <div class="shortcut-list">
        <div><kbd>Space</kbd> or <kbd>→</kbd><span>Next slide in the audience display</span></div>
        <div><kbd>←</kbd><span>Previous slide</span></div>
        <div><kbd>F</kbd><span>Fullscreen the audience display</span></div>
        <div><kbd>Ctrl/Cmd + K</kbd><span>Search presentations, songs, media and plans</span></div>
        <div><kbd>Ctrl/Cmd + S</kbd><span>Save the current presentation</span></div>
        <div><kbd>Ctrl/Cmd + Z</kbd><span>Undo slide change</span></div>
        <div><kbd>Esc</kbd><span>Close dialogs</span></div>
      </div>`);
    return;
  }
  modal(`<h2>About Simple Worship Presenter</h2>
    <p>Simple Worship Presenter is an independent, self-hostable worship presentation tool created and maintained by <a href="https://alexanderwasson.dev/" rel="noreferrer">Alexander Wasson</a>. It is not affiliated with or a reproduction of any other presentation product.</p>
    <h3>AI transparency</h3>
    <p>Parts of this software were produced with AI-assisted development and reviewed by a human before release. AI is not used to generate or store your lyrics, media or account content. You remain responsible for holding the rights to any content you upload or present.</p>
    <h3>Your content</h3>
    <p>This software does not ship copyrighted song lyrics or Bible translations. Add only content you own or are licensed to use, and record your CCLI licence in Settings.</p>
    <p><a href="/terms">Terms of Use</a> · <a href="/privacy">Privacy</a> · <a href="/self-hosting">Self-hosting</a></p>`);
}

/* --------------------------------------------------------------- wiring */
function wire() {
  $$('.nav-item').forEach(b => b.onclick = () => showView(b.dataset.view));
  $('#newDeckBtn').onclick = newPresentation;
  $('#newProgramBtn').onclick = newProgram;
  $('#newSongBtn').onclick = () => openSong(null);
  $('#backToLibrary').onclick = () => showView('library');
  $('#avatar').onclick = () => state.user ? showView('settings') : showAuth('login');
  $('#quickBlack').onclick = toggleBlank;
  $('#quickLive').onclick = openPresenter;
  $('#modalClose').onclick = closeModal;
  $('#modalBackdrop').onclick = e => { if (e.target.id === 'modalBackdrop') closeModal(); };
  $$('[data-modal]').forEach(b => b.onclick = () => openModal(b.dataset.modal));

  $('#mediaUpload').onchange = e => { uploadMedia([...e.target.files]); e.target.value = ''; };
  $('#mediaAdd').onclick = () => $('#backgroundInput').click();
  $('#mediaRefresh').onclick = () => { renderControlRoom(); toast('Slide list refreshed'); };
  $('#mediaFilter').oninput = renderControlRoom;
  $('#sendSelected').onclick = () => { broadcast(); toast('Sent to audience display'); };
  $('#queueAdd').onclick = () => addSlide();
  $('#queueBlank').onclick = toggleBlank;

  $('#backgroundInput').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { media } = await api('/media', { method: 'POST', body: toForm(file) });
      applyBackground(`url("/api/media/${media.id}/file") center/cover no-repeat`);
      loadMedia();
      toast('Background applied');
    } catch (err) { toast(err.message, 'error'); }
    e.target.value = '';
  };

  $('#importInput').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const chunks = text.split(/\r?\n\s*\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!chunks.length) return toast('No slide content found in that file', 'error');
    const created = await api('/presentations', { method: 'POST', body: { title: file.name.replace(/\.[^.]+$/, ''), slides: chunks.slice(0, 200) } });
    await loadPresentations();
    openDeck(state.presentations.find(p => p.id === created.id) || created);
    toast(chunks.length + ' slides imported');
    e.target.value = '';
  };

  $$('#canvasToolbar [data-tool]').forEach(b => b.onclick = () => {
    const tool = b.dataset.tool;
    if (tool === 'undo') undo();
    else if (tool === 'redo') redo();
    else if (tool === 'add') addSlide();
    else if (tool === 'dup') duplicateSlide();
    else if (tool === 'up') moveSlide(-1);
    else if (tool === 'down') moveSlide(1);
    else if (tool === 'del') deleteSlide();
    else if (tool === 'aspect') toggleAspect();
  });

  $('#editorTitle').addEventListener('input', () => {
    $('#crumbTitle').textContent = $('#editorTitle').textContent;
    scheduleSave();
    broadcast();
  });

  // ---- search ----------------------------------------------------------
  const bindSearch = (id, key, render) => {
    const el = $(id);
    if (!el) return;
    el.oninput = () => { state.query[key] = el.value; render(); };
  };
  bindSearch('#searchPresentations', 'presentations', renderLibrary);
  bindSearch('#searchPrograms', 'programs', renderPrograms);
  bindSearch('#searchSongs', 'songs', renderSongs);
  bindSearch('#searchMedia', 'media', renderMedia);
  bindSearch('#searchSlides', 'slides', renderEditor);

  const gs = $('#globalSearch'), sr = $('#searchResults');
  function renderGlobalResults() {
    const q = gs.value.trim();
    if (!q) { sr.hidden = true; sr.innerHTML = ''; return; }
    const groups = [
      ['Presentations', state.presentations.filter(p => matches(q, p.title, ...p.slides.map(slideText))).slice(0, 5).map(p => ({ label: p.title, kind: p.slides.length + ' slides', go: () => openDeck(p) }))],
      ['Songs', state.songs.filter(s => matches(q, s.title, s.artist, s.author, ...s.sections.map(x => x.label + ' ' + x.text))).slice(0, 5).map(s => ({ label: s.title, kind: s.artist || 'song', go: () => { showView('songs'); openSong(s); } }))],
      ['Service plans', state.programs.filter(p => matches(q, p.title, p.date, p.notes)).slice(0, 4).map(p => ({ label: p.title, kind: p.date, go: () => programEditor(p) }))],
      ['Media', state.media.filter(m => matches(q, m.original_name, m.kind)).slice(0, 5).map(m => ({ label: m.original_name, kind: m.kind, go: () => showView('media') }))]
    ].filter(([, items]) => items.length);

    if (!groups.length) {
      sr.innerHTML = `<div class="sr-empty">Nothing matches “${esc(q)}”.</div>`;
      sr.hidden = false;
      return;
    }
    sr.innerHTML = groups.map(([name, items]) =>
      `<div class="sr-group">${name}</div>` + items.map((item, n) =>
        `<button data-g="${esc(name)}" data-n="${n}">${esc(item.label)}<span class="sr-kind">${esc(item.kind)}</span></button>`).join('')
    ).join('');
    sr.hidden = false;
    $$('#searchResults [data-g]').forEach(btn => btn.onclick = () => {
      const group = groups.find(([name]) => name === btn.dataset.g);
      const item = group && group[1][Number(btn.dataset.n)];
      sr.hidden = true;
      gs.value = '';
      if (item) item.go();
    });
  }
  gs.oninput = renderGlobalResults;
  gs.onfocus = renderGlobalResults;
  document.addEventListener('click', e => {
    if (!e.target.closest('.global-search')) sr.hidden = true;
  });

  document.addEventListener('keydown', e => {
    const typing = /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === 'Escape') { closeModal(); $$('.menu-dropdown').forEach(m => m.classList.remove('open')); if ($('#searchResults')) $('#searchResults').hidden = true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const field = $('#globalSearch');
      if (field) { field.focus(); field.select(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveDeck(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    }
    // Operator slide control: Space / arrows drive the live output.
    const modalOpen = $('#modalBackdrop').classList.contains('open');
    if (!typing && !modalOpen && state.deck && (e.code === 'Space' || e.key === 'ArrowRight')) {
      e.preventDefault();
      nextSlide();
    }
    if (!typing && !modalOpen && state.deck && e.key === 'ArrowLeft') {
      e.preventDefault();
      prevSlide();
    }
  });

  window.addEventListener('resize', () => {
    if (state.deck) applySlideStyle(slideStyle(state.deck.slides[state.active]));
  });

  window.addEventListener('beforeunload', e => {
    if (state.deck && $('#saveStatus').textContent.includes('Editing')) { e.preventDefault(); e.returnValue = ''; }
  });
}

function toForm(file) {
  const f = new FormData();
  f.append('file', file);
  return f;
}

/* dummy config namespace kept for footer rendering */
const config = { instanceName: 'Simple Worship Presenter' };

wire();
mountMenus();
boot();
// Keep the server's live state in step and follow any remote that takes over.
LiveLink.connect();
// Bible browser wiring.
if ($('#bibleBookList')) {
  Bible.init();
  $('#bibleBookFilter').oninput = () => Bible.renderBooks();
  $('#bibleTranslation').onchange = e => { Bible.translation = e.target.value; Bible.loadBooks(); };
  $('#bibleRefGo').onclick = () => Bible.findReference($('#bibleRefInput').value);
  $('#bibleRefInput').onkeydown = e => { if (e.key === 'Enter') Bible.findReference(e.target.value); };
  $('#bibleSearchGo').onclick = () => Bible.findWords($('#bibleSearchInput').value);
  $('#bibleSearchInput').onkeydown = e => { if (e.key === 'Enter') Bible.findWords(e.target.value); };
  $('#biblePrevChapter').onclick = () => { if (Bible.book && Bible.chapter > 1) Bible.openChapter(Bible.book, Bible.chapter - 1); };
  $('#bibleNextChapter').onclick = () => { if (Bible.book) Bible.openChapter(Bible.book, Bible.chapter + 1); };
}