'use strict';

/**
 * The inspector.
 *
 * Three panes: what is being emulated, what arrived, and what it said. Jobs are
 * a table rather than a gallery because the common task is scanning a few
 * hundred of them for the one that is wrong - and because the columns that
 * matter (time, device, size, flags) are exactly what a table shows and a card
 * hides.
 *
 * All rendering is a full redraw of the affected pane from `state`. At a few
 * thousand rows that is fast enough, and it removes the class of bug where the
 * screen and the data disagree after a live update.
 */

const $ = (sel) => document.querySelector(sel);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c]);

const MODES = ['accept', 'reset', 'hang', 'refuse'];
const TABS = ['paper', 'text', 'hex', 'events'];

/**
 * Escaped text with every occurrence of `needle` marked.
 *
 * Split on the match first and escape the pieces, rather than escaping and
 * then searching: a filter for `&` or `<` would otherwise hunt for text that no
 * longer exists, and inserting tags into already-escaped text is how a marker
 * ends up visible on screen.
 */
function highlight(text, needle) {
  const hay = String(text ?? '');
  const find = String(needle ?? '').trim();
  if (!find) return esc(hay);

  const lower = hay.toLowerCase();
  const target = find.toLowerCase();
  let out = '';
  let at = 0;

  for (;;) {
    const found = lower.indexOf(target, at);
    if (found === -1) break;
    out += esc(hay.slice(at, found));
    out += `<mark>${esc(hay.slice(found, found + find.length))}</mark>`;
    at = found + find.length;
  }
  return out + esc(hay.slice(at));
}

/** A column ruler, so "too wide for the roll" is something you can see. */
function rulerFor(columns) {
  let scale = '';
  let ticks = '';
  for (let c = 1; c <= columns; c += 1) {
    if (c % 10 === 0) {
      scale = scale.slice(0, Math.max(0, scale.length - String(c).length + 1)) + String(c);
      ticks += '|';
    } else {
      scale += ' ';
      ticks += c % 5 === 0 ? '+' : '.';
    }
  }
  return `<div class="ruler"><pre>${esc(scale)}\n${esc(ticks)}</pre></div>`;
}

const state = {
  devices: [],
  jobs: [],
  jobDetail: new Map(),
  deviceFilter: null,
  selectedId: null,
  query: '',
  dupesOnly: false,
  follow: true,
  tab: 'paper',
};

const deviceName = (id) => (state.devices.find((d) => d.id === id) || {}).name || id;

/**
 * The row number of a job, for referring to it on screen.
 *
 * Job ids are opaque and long; the "#" in the table is what someone is actually
 * looking at. Falls back to the id when the original has been pruned out of the
 * log, which is rare but should say something rather than nothing.
 */
const seqOf = (id) => {
  const job = state.jobs.find((j) => j.id === id);
  return job ? job.seq : id;
};

const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '--:--:--'
    : d.toLocaleTimeString('en-GB', { hour12: false }) +
        '.' +
        String(d.getMilliseconds()).padStart(3, '0');
};

/** Jobs passing every active filter, oldest first. */
function visibleJobs() {
  const needle = state.query.trim().toLowerCase();
  return state.jobs.filter((j) => {
    if (state.deviceFilter && j.deviceId !== state.deviceFilter) return false;
    if (state.dupesOnly && !j.duplicateOf) return false;
    if (needle && !(j.text || '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

// ── device rail ────────────────────────────────────────────────────────────

function renderRail() {
  const list = $('#device-list');
  const total = state.jobs.length;

  const allSelected = state.deviceFilter === null ? ' is-selected' : '';
  const rows = [
    `<li class="device${allSelected}" data-device="">
       <div class="device-row">
         <span class="device-name">All devices</span>
         <span class="device-jobs">${total}</span>
       </div>
     </li>`,
  ];

  for (const d of state.devices) {
    const jobs = state.jobs.filter((j) => j.deviceId === d.id);
    const dupes = jobs.filter((j) => j.duplicateOf).length;
    const selected = state.deviceFilter === d.id ? ' is-selected' : '';

    rows.push(`
      <li class="device${selected}" data-device="${esc(d.id)}">
        <div class="device-row">
          <span class="led ${esc(d.mode)}" title="${esc(d.mode)}"></span>
          <span class="device-name" title="${esc(d.name)}">${esc(d.name)}</span>
          <span class="device-jobs">${jobs.length}${
            dupes ? ` <span class="dup">+${dupes}</span>` : ''
          }</span>
        </div>
        <div class="device-addr">
          ${esc(d.ip)}:${d.port} &middot; ${d.columns}col
          ${d.listening ? '' : '<span class="down-tag">not listening</span>'}
        </div>
        ${d.lastError ? `<div class="device-err" title="${esc(d.lastError)}">${esc(d.lastError)}</div>` : ''}
        <div class="device-controls">
          <select data-mode-for="${esc(d.id)}" title="Failure mode">
            ${MODES.map(
              (m) => `<option value="${m}"${m === d.mode ? ' selected' : ''}>${m}</option>`
            ).join('')}
          </select>
          <input type="number" min="0" placeholder="∞" title="Sheets of paper left; blank is an endless roll"
                 data-paper-for="${esc(d.id)}" value="${d.paper === null ? '' : d.paper}" />
          <button class="btn tiny" data-clear-for="${esc(d.id)}" type="button"
                  title="Clear this device's jobs">Clear</button>
        </div>
      </li>`);
  }

  list.innerHTML = rows.join('');
  $('#device-count').textContent = String(state.devices.length);
}

// ── job table ──────────────────────────────────────────────────────────────

function flagsFor(job) {
  const kinds = new Set((job.events || []).map((e) => e.type));
  const tags = [];
  if (job.duplicateOf) tags.push('<span class="tag dup">DUP</span>');
  if ((job.overWidth || []).length) tags.push('<span class="tag wide">WIDE</span>');
  if (kinds.has('unknown')) tags.push('<span class="tag wide">?CMD</span>');
  if (kinds.has('drawer')) tags.push('<span class="tag">DRW</span>');
  if (kinds.has('barcode') || kinds.has('qr')) tags.push('<span class="tag">BC</span>');
  if (kinds.has('image')) tags.push('<span class="tag">IMG</span>');
  return tags.join('');
}

/**
 * The line to show in the preview column.
 *
 * With no filter, the first line with anything on it - the ticket's heading,
 * which is what identifies it. With a filter, the line that actually matched,
 * the way grep shows you the hit rather than the top of the file. Showing the
 * heading while the match is nine lines below it tells you nothing about why
 * the row is in the list.
 */
const previewOf = (job, query) => {
  const lines = (job.text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const needle = String(query || '').trim().toLowerCase();
  if (needle) {
    const hit = lines.find((l) => l.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return lines[0] || '';
};

function renderRows() {
  const jobs = visibleJobs();
  const body = $('#rows');

  body.innerHTML = jobs
    .map(
      (j) => `
      <tr data-id="${esc(j.id)}"${j.id === state.selectedId ? ' class="is-selected"' : ''}>
        <td class="col-seq">${j.seq}</td>
        <td class="col-time">${esc(timeOf(j.at))}</td>
        <td class="col-device" title="${esc(deviceName(j.deviceId))}">${esc(j.deviceId)}</td>
        <td class="col-num">${j.byteLength}</td>
        <td class="col-num">${(j.lines || []).length}</td>
        <td class="col-flags">${flagsFor(j)}</td>
        <td class="col-preview">${highlight(previewOf(j, state.query), state.query)}</td>
      </tr>`
    )
    .join('');

  $('#list-empty').hidden = jobs.length > 0;
  $('#list-empty').textContent = state.jobs.length
    ? 'No jobs match the current filter.'
    : 'No jobs recorded.';
}

function scrollSelectedIntoView() {
  const row = $(`#rows tr[data-id="${CSS.escape(state.selectedId || '')}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// ── detail ─────────────────────────────────────────────────────────────────

function paperHtml(job) {
  const body = (job.lines || [])
    .map((line) => {
      const inner = (line.spans || [])
        .map((s) => {
          const cls = [];
          if (s.bold) cls.push('b');
          if (s.underline) cls.push('u');
          if (s.w > 1) cls.push('w2');
          if (s.h > 1) cls.push('h2');
          if (s.invert) cls.push('inv');
          return cls.length ? `<span class="${cls.join(' ')}">${esc(s.text)}</span>` : esc(s.text);
        })
        .join('');
      const spanLen = (line.spans || []).reduce((n, s) => n + [...s.text].length, 0);
      const pad = Math.max(0, (line.text || '').length - spanLen);
      const content = ' '.repeat(pad) + inner;
      return line.over ? `<span class="over">${content || ' '}</span>` : content;
    })
    .join('\n');

  const images = (job.images || [])
    .map((i) => `<img src="${esc(i.dataUri)}" alt="raster image ${i.width}×${i.height}" />`)
    .join('');

  const over = (job.overWidth || []).length;
  const note = over
    ? `<p class="paper-note warn">${over} line${over === 1 ? '' : 's'} wider than the
       ${job.columns}-column roll — a real device would wrap or clip ${
         over === 1 ? 'it' : 'them'
       }.</p>`
    : '';

  return (
    `<div class="paper-wrap" style="--cols:${job.columns}">` +
    rulerFor(job.columns) +
    `<div class="paper"><pre>${body}</pre>${images}</div>` +
    note +
    '</div>'
  );
}

function hexHtml(b64) {
  let bin;
  try {
    bin = atob(b64 || '');
  } catch (_) {
    return '(bytes unavailable)';
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const out = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = [...bytes.slice(i, i + 16)];
    const hex = row
      .map((x) => {
        const h = x.toString(16).padStart(2, '0');
        // The command introducers, so the structure is readable at a glance.
        return x === 0x1b || x === 0x1d || x === 0x1c ? `<b>${h}</b>` : h;
      })
      .join(' ');
    const width = 16 * 3 - 1;
    const ascii = row
      .map((x) => (x >= 0x20 && x < 0x7f ? esc(String.fromCharCode(x)) : '.'))
      .join('');
    out.push(
      `${i.toString(16).padStart(6, '0')}  ${hex}${' '.repeat(
        Math.max(0, width - (row.length * 3 - 1))
      )}  ${ascii}`
    );
  }
  return out.join('\n') || '(empty)';
}

function eventsHtml(job) {
  const rows = (job.events || []).map((e) => {
    const { type, at, ...rest } = e;
    const detail = Object.keys(rest).length ? JSON.stringify(rest) : '';
    return `<tr><td class="k">${esc(type)}</td><td class="at">${at}</td><td class="v">${esc(
      detail.length > 300 ? `${detail.slice(0, 300)}…` : detail
    )}</td></tr>`;
  });
  return rows.length
    ? `<table class="events">${rows.join('')}</table>`
    : '<p class="placeholder">No commands beyond text.</p>';
}

function showTab(name) {
  if (!TABS.includes(name)) return;
  state.tab = name;
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('is-active', t.dataset.tab === name);
  }
  for (const p of TABS) $(`#pane-${p}`).hidden = p !== name;
}

function renderDetail() {
  const job = state.selectedId ? state.jobDetail.get(state.selectedId) : null;

  $('#copy').disabled = !job;

  if (!job) {
    $('#detail-title').textContent = state.selectedId ? 'Loading…' : 'No job selected';
    $('#pane-paper').innerHTML = state.selectedId
      ? '<p class="placeholder">Loading…</p>'
      : `<p class="placeholder">Select a job to see what the printer received.<br />
         <span class="muted">↑↓ or j/k to move · 1–4 for tabs · / to filter</span></p>`;
    $('#pane-text').textContent = '';
    $('#pane-hex').textContent = '';
    $('#pane-events').innerHTML = '';
    return;
  }

  $('#detail-title').innerHTML =
    `<b>${esc(deviceName(job.deviceId))}</b> &middot; ${esc(timeOf(job.at))} &middot; ` +
    `${job.byteLength} bytes &middot; ${(job.lines || []).length} lines &middot; ` +
    `${esc((job.codePages || []).join(', '))}` +
    (job.duplicateOf ? ` &middot; <span class="dup">repeat of #${esc(seqOf(job.duplicateOf))}</span>` : '');

  $('#pane-paper').innerHTML = paperHtml(job);
  $('#pane-text').innerHTML = highlight(job.text || '', state.query);
  $('#pane-hex').innerHTML = hexHtml(job.bytesB64);
  $('#pane-events').innerHTML = eventsHtml(job);
}

/** What the Copy button puts on the clipboard depends on the tab you are on. */
function copyableText(job) {
  if (!job) return '';
  if (state.tab === 'text' || state.tab === 'paper') return job.text || '';
  if (state.tab === 'hex') return $('#pane-hex').textContent || '';
  return (job.events || [])
    .map((e) => {
      const { type, at, ...rest } = e;
      return `${String(at).padStart(6)}  ${type}  ${JSON.stringify(rest)}`;
    })
    .join('\n');
}

async function select(id, { scroll = false } = {}) {
  state.selectedId = id;
  renderRows();
  if (scroll) scrollSelectedIntoView();

  if (!id) return renderDetail();

  if (!state.jobDetail.has(id)) {
    renderDetail();
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(String(res.status));
      const { job } = await res.json();
      state.jobDetail.set(id, job);
    } catch (_) {
      // A job pruned out of the log between listing and opening it.
      state.jobDetail.set(id, null);
    }
  }
  // The selection may have moved on while that request was in flight.
  if (state.selectedId === id) renderDetail();
}

function moveSelection(delta) {
  const jobs = visibleJobs();
  if (jobs.length === 0) return;
  const at = jobs.findIndex((j) => j.id === state.selectedId);
  const next = at === -1 ? jobs.length - 1 : Math.min(jobs.length - 1, Math.max(0, at + delta));
  select(jobs[next].id, { scroll: true });
}

// ── status ─────────────────────────────────────────────────────────────────

const humanBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

function renderStatus() {
  const visible = visibleJobs();
  const total = state.jobs.length;
  const dupes = state.jobs.filter((j) => j.duplicateOf).length;
  const wide = state.jobs.filter((j) => (j.overWidth || []).length).length;
  const bytes = visible.reduce((n, j) => n + (j.byteLength || 0), 0);

  $('#status-counts').innerHTML =
    `${visible.length === total ? total : `${visible.length} of ${total}`} job${
      total === 1 ? '' : 's'
    }` +
    ` · ${humanBytes(bytes)}` +
    (dupes ? ` <span class="flag">· ${dupes} duplicate${dupes === 1 ? '' : 's'}</span>` : '') +
    (wide ? ` <span class="warn">· ${wide} over width</span>` : '');
}

function setConnection(kind) {
  const node = $('#status-conn');
  node.className = `conn ${kind === 'live' ? 'live' : kind === 'down' ? 'down' : ''}`;
  node.textContent = kind === 'live' ? 'connected' : kind === 'down' ? 'disconnected' : 'connecting';
}

function renderAll() {
  renderRail();
  renderRows();
  renderStatus();
}

// ── data ───────────────────────────────────────────────────────────────────

async function loadAll() {
  const [devicesRes, jobsRes] = await Promise.all([
    fetch('/api/devices'),
    fetch('/api/jobs?limit=1000'),
  ]);
  state.devices = (await devicesRes.json()).devices || [];
  state.jobs = (await jobsRes.json()).jobs || [];
  renderAll();

  if (state.follow && state.jobs.length) {
    select(state.jobs[state.jobs.length - 1].id, { scroll: true });
  } else {
    renderDetail();
  }
}

function onJob(job) {
  state.jobs.push(job);
  renderRail();
  renderRows();
  renderStatus();

  if (state.follow) {
    const visible = visibleJobs();
    // Only jump to it if it passes the filters the user has set.
    if (visible.length && visible[visible.length - 1].id === job.id) {
      select(job.id, { scroll: true });
    }
  }
}

function connect() {
  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => setConnection('live'));
  source.addEventListener('error', () => setConnection('down'));

  source.addEventListener('job', (e) => {
    try {
      onJob(JSON.parse(e.data));
    } catch (_) {
      /* a malformed frame must not take the screen down */
    }
  });

  source.addEventListener('mode', (e) => {
    try {
      const { device } = JSON.parse(e.data);
      const at = state.devices.findIndex((d) => d.id === device.id);
      if (at >= 0) state.devices[at] = device;
      renderRail();
    } catch (_) {
      /* ignore */
    }
  });

  source.addEventListener('paperOut', () => refreshDevices());

  source.addEventListener('reset', () => {
    state.jobs = [];
    state.jobDetail.clear();
    state.selectedId = null;
    renderAll();
    renderDetail();
  });
}

async function refreshDevices() {
  try {
    const res = await fetch('/api/devices');
    state.devices = (await res.json()).devices || [];
    renderRail();
  } catch (_) {
    /* the stream will report the disconnection */
  }
}

// ── events ─────────────────────────────────────────────────────────────────

$('#device-list').addEventListener('click', async (e) => {
  const clear = e.target.closest('[data-clear-for]');
  if (clear) {
    const id = clear.dataset.clearFor;
    await fetch(`/api/devices/${encodeURIComponent(id)}/reset`, { method: 'POST' }).catch(() => {});
    for (const j of state.jobs.filter((j2) => j2.deviceId === id)) state.jobDetail.delete(j.id);
    state.jobs = state.jobs.filter((j) => j.deviceId !== id);
    if (!state.jobs.some((j) => j.id === state.selectedId)) state.selectedId = null;
    renderAll();
    renderDetail();
    return;
  }

  if (e.target.closest('select, input')) return;
  const li = e.target.closest('.device');
  if (!li) return;
  state.deviceFilter = li.dataset.device || null;
  renderRail();
  renderRows();
  renderStatus();
});

$('#device-list').addEventListener('change', async (e) => {
  const mode = e.target.closest('[data-mode-for]');
  if (mode) {
    const id = mode.dataset.modeFor;
    await fetch(`/api/devices/${encodeURIComponent(id)}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode.value }),
    }).catch(() => {});
    return refreshDevices();
  }

  const paper = e.target.closest('[data-paper-for]');
  if (paper) {
    const id = paper.dataset.paperFor;
    const sheets = paper.value === '' ? null : Number(paper.value);
    await fetch(`/api/devices/${encodeURIComponent(id)}/paper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheets }),
    }).catch(() => {});
    return refreshDevices();
  }
  return undefined;
});

$('#rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) select(tr.dataset.id);
});

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});

const applyFilter = () => {
  $('#q-clear').hidden = state.query === '';
  renderRows();
  renderStatus();
};

$('#q').addEventListener('input', (e) => {
  state.query = e.target.value;
  applyFilter();
});

$('#q-clear').addEventListener('click', () => {
  state.query = '';
  $('#q').value = '';
  applyFilter();
  $('#q').focus();
});

$('#dupes-only').addEventListener('change', (e) => {
  state.dupesOnly = e.target.checked;
  renderRows();
  renderStatus();
});

$('#follow').addEventListener('change', (e) => {
  state.follow = e.target.checked;
});

$('#export').addEventListener('click', () => {
  const params = new URLSearchParams({ format: 'jsonl' });
  if (state.deviceFilter) params.set('deviceId', state.deviceFilter);
  if (state.query.trim()) params.set('q', state.query.trim());
  window.location.href = `/api/export?${params}`;
});

$('#clear-all').addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' }).catch(() => {});
  state.jobs = [];
  state.jobDetail.clear();
  state.selectedId = null;
  renderAll();
  renderDetail();
});

$('#copy').addEventListener('click', async () => {
  const job = state.selectedId ? state.jobDetail.get(state.selectedId) : null;
  const text = copyableText(job);
  if (!text) return;

  const button = $('#copy');
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch (_) {
    // Clipboard access is refused on insecure origins in some browsers; say so
    // rather than appearing to have worked.
    button.textContent = 'Blocked';
  }
  setTimeout(() => {
    button.textContent = 'Copy';
  }, 1200);
});

document.addEventListener('keydown', (e) => {
  // `e.target` is not always an element - it is `document` itself when nothing
  // is focused - and calling `.matches` on that throws, which killed the whole
  // handler and left the keyboard doing nothing at all.
  const target = e.target instanceof Element ? e.target : null;
  const typing = Boolean(target && target.matches('input, select, textarea'));
  if (typing) {
    // Escape empties the filter on the first press and gives the list back on
    // the second, so there is always a way out without reaching for the mouse.
    if (e.key === 'Escape') {
      if (target.id === 'q' && target.value !== '') {
        state.query = '';
        target.value = '';
        applyFilter();
      } else {
        target.blur();
      }
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const jobs = visibleJobs();

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === 'g' && jobs.length) {
    e.preventDefault();
    select(jobs[0].id, { scroll: true });
  } else if (e.key === 'G' && jobs.length) {
    e.preventDefault();
    select(jobs[jobs.length - 1].id, { scroll: true });
  } else if (e.key >= '1' && e.key <= '4') {
    showTab(TABS[Number(e.key) - 1]);
  } else if (e.key === '/') {
    e.preventDefault();
    $('#q').focus();
    $('#q').select();
  } else if (e.key === 'Escape' && state.query) {
    state.query = '';
    $('#q').value = '';
    applyFilter();
  }
});

loadAll()
  .then(connect)
  .catch(() => setConnection('down'));
