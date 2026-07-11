// ============================================================================
// State
// ============================================================================
let currentPage = 1;
let totalPages = 1;
let totalCount = 0;
const pageSize = 50;

const el = {
  loading: document.getElementById('loading'),
  content: document.getElementById('content'),
  channelList: document.getElementById('channelList'),
  noResults: document.getElementById('noResults'),
  searchInput: document.getElementById('searchInput'),
  resetBtn: document.getElementById('resetBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  channelCount: document.getElementById('channelCount'),
  resultCount: document.getElementById('resultCount'),
  totalCount: document.getElementById('totalCount'),
  lastUpdate: document.getElementById('lastUpdate'),
};

// ============================================================================
// Custom combobox — replaces native <select>.
// Native <select> popups are rendered by the OS on some browsers (notably
// Windows Chrome/Edge), which ignores page CSS for <option> colors and can
// render white-on-white. This component is fully styled by us, so contrast
// is guaranteed everywhere.
// ============================================================================
function createCombobox(container, { placeholder, searchable = true, onChange }) {
  let options = [];       // [{value, label}]
  let selected = '';
  let open = false;
  let activeIndex = -1;
  let filterText = '';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'combo-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');

  const btnLabel = document.createElement('span');
  btnLabel.className = 'truncate';
  const chevron = document.createElement('svg');
  chevron.setAttribute('class', 'w-4 h-4 flex-shrink-0 text-[var(--text-lo)]');
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', 'currentColor');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>';
  btn.appendChild(btnLabel);
  btn.appendChild(chevron);

  const panel = document.createElement('div');
  panel.className = 'combo-panel hidden';
  panel.setAttribute('role', 'listbox');

  let searchInput = null;
  if (searchable) {
    const searchWrap = document.createElement('div');
    searchWrap.className = 'combo-search';
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Filter…';
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchInput);
    panel.appendChild(searchWrap);
  }

  const list = document.createElement('div');
  list.className = 'combo-list';
  panel.appendChild(list);

  container.appendChild(btn);
  container.appendChild(panel);

  function renderLabel() {
    const match = options.find(o => o.value === selected);
    if (match) {
      btnLabel.textContent = match.label;
      btnLabel.classList.remove('placeholder');
    } else {
      btnLabel.textContent = placeholder;
      btnLabel.classList.add('placeholder');
    }
  }

  function renderList() {
    const q = filterText.trim().toLowerCase();
    const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;

    if (!filtered.length) {
      list.innerHTML = '<div class="combo-empty">No matches</div>';
      return;
    }

    list.innerHTML = '';
    filtered.forEach((opt, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'combo-opt' + (opt.value === selected ? ' is-selected' : '');
      item.textContent = opt.label;
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;
      if (i === activeIndex) item.classList.add('is-active');
      item.addEventListener('click', () => selectValue(opt.value));
      list.appendChild(item);
    });
  }

  function selectValue(value) {
    selected = value;
    renderLabel();
    closePanel();
    onChange && onChange(value);
  }

  function openPanel() {
    open = true;
    activeIndex = -1;
    filterText = '';
    if (searchInput) searchInput.value = '';
    panel.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    renderList();
    if (searchInput) setTimeout(() => searchInput.focus(), 0);
  }

  function closePanel() {
    open = false;
    panel.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', () => (open ? closePanel() : openPanel()));

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      filterText = searchInput.value;
      activeIndex = -1;
      renderList();
    });
    searchInput.addEventListener('keydown', handleKeydown);
  }

  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) openPanel();
    }
  });

  function handleKeydown(e) {
    const q = filterText.trim().toLowerCase();
    const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
      renderList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIndex]) selectValue(filtered[activeIndex].value);
    } else if (e.key === 'Escape') {
      closePanel();
      btn.focus();
    }
  }

  document.addEventListener('click', (e) => {
    if (open && !container.contains(e.target)) closePanel();
  });

  renderLabel();

  return {
    setOptions(list) { options = list; renderLabel(); if (open) renderList(); },
    getValue() { return selected; },
    reset() { selected = ''; renderLabel(); },
  };
}

const siteCombo = createCombobox(document.getElementById('siteCombo'), {
  placeholder: 'All sites', searchable: true,
  onChange: () => handleFilterChange(),
});
const langCombo = createCombobox(document.getElementById('langCombo'), {
  placeholder: 'All languages', searchable: true,
  onChange: () => handleFilterChange(),
});

// ============================================================================
// Networking
// ============================================================================

// Safe fetch wrapper — always returns parsed JSON or an error object,
// never throws even if the server returns HTML or times out.
async function safeFetch(url, options = {}) {
  try {
    const resp = await fetch(url, options);
    const text = await resp.text();
    try {
      return { ok: resp.ok, status: resp.status, data: JSON.parse(text) };
    } catch (e) {
      console.error(`Non-JSON response from ${url} (${resp.status}):`, text.substring(0, 200));
      return { ok: false, status: resp.status, data: { error: `Server error ${resp.status}`, message: text.substring(0, 200) } };
    }
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Network error', message: e.message } };
  }
}

async function fetchStats() {
  const { data } = await safeFetch('/api/stats');
  if (data.totalChannels !== undefined) {
    el.channelCount.textContent = data.totalChannels.toLocaleString();
    el.totalCount.textContent = data.totalChannels.toLocaleString();
    if (data.lastUpdate) el.lastUpdate.textContent = new Date(data.lastUpdate).toLocaleString();
  }
  return data;
}

async function fetchFilters() {
  const { data } = await safeFetch('/api/filters');
  if (!data.sites) return;
  siteCombo.setOptions((data.sites || []).map(s => ({ value: s, label: s })));
  langCombo.setOptions((data.languages || []).map(l => ({ value: l, label: l.toUpperCase() })));
}

async function fetchChannels() {
  const params = new URLSearchParams({ page: currentPage, limit: pageSize });
  const search = el.searchInput.value;
  const site = siteCombo.getValue();
  const lang = langCombo.getValue();
  if (search) params.append('search', search);
  if (site) params.append('site', site);
  if (lang) params.append('lang', lang);

  const { ok, data } = await safeFetch(`/api/channels?${params}`);
  if (!ok || !data.channels) {
    el.loading.innerHTML = `
      <div class="text-center">
        <p class="text-xl font-display text-[var(--text-hi)] mb-2">Failed to load channels</p>
        <p class="text-sm text-[var(--text-lo)] mb-4">${escHtml(data.message || data.error || 'Unknown error')}</p>
        <button onclick="location.reload()" class="btn btn-amber">Retry</button>
      </div>`;
    el.loading.classList.remove('hidden');
    el.content.classList.add('hidden');
    return;
  }

  totalPages = data.pagination.totalPages;
  totalCount = data.pagination.totalCount;
  el.resultCount.textContent = totalCount.toLocaleString();

  renderChannels(data.channels);
  renderPagination();

  if (data.lastUpdate) el.lastUpdate.textContent = new Date(data.lastUpdate).toLocaleString();
  el.loading.classList.add('hidden');
  el.content.classList.remove('hidden');
}

// ============================================================================
// Logos
//
// The server (server.js -> findLogo()) already runs a thorough multi-candidate
// match against the logo manifest before a channel is stored, so `ch.logo` is
// the best answer we're going to get. If it's empty, there is no point
// re-guessing the same URL pattern on the client — it already failed
// server-side and will 404 here too, for no benefit. So: trust the server,
// and fall straight to a placeholder when it found nothing.
//
// The placeholder itself used to be built with btoa(), which throws on any
// non-Latin1 character. Since this catalog spans channels from 150+
// countries, most logo-less channel names (Thai, Chinese, Arabic, Cyrillic…)
// crashed the fallback entirely, leaving a permanently broken image icon.
// Using an encodeURIComponent-based data URI avoids that — no base64 needed.
// ============================================================================

function makePlaceholder(name) {
  const initials = (name || '??').trim().substring(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
    <rect width="80" height="80" rx="10" fill="#141a22"/>
    <rect width="80" height="80" rx="10" fill="none" stroke="#25303c" stroke-width="1"/>
    <text x="40" y="49" font-family="'JetBrains Mono',monospace" font-size="22" font-weight="600"
          text-anchor="middle" fill="#f5a623">${escXml(initials)}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getLogoSrc(ch) {
  if (ch.logo && ch.logo.trim()) return ch.logo;
  return makePlaceholder(ch.name);
}

// Single-shot fallback: if a real logo URL (from the server) turns out to be
// dead (rotted link, moved file, etc.), drop straight to the placeholder.
// No further guessing — avoids repeat 404s against tvlogos.austheim.app.
function handleLogoError(img, name) {
  img.onerror = null;
  img.src = makePlaceholder(name);
}

// ============================================================================
// Clipboard / reporting
// ============================================================================

function xmlLine(ch) {
  return `<channel site="${ch.site}" lang="${ch.lang}" xmltv_id="${ch.xmltv_id}" site_id="${ch.site_id}">${ch.name}</channel>`;
}

async function copyToClipboard(text, btn, type) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.innerHTML;
    const labels = { source: '✓ Copied!', xmltv: '✓ Copied XMLTV!', siteid: '✓ Copied ID!' };
    const restoreClass = btn.dataset.variant;
    btn.innerHTML = labels[type];
    btn.classList.remove('btn-amber', 'btn-cyan', 'btn-violet');
    btn.classList.add('btn-success');
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.classList.remove('btn-success');
      btn.classList.add(restoreClass);
    }, 1800);
  } catch (e) { alert('Copy failed'); }
}

async function reportChannel(encoded) {
  const ch = JSON.parse(decodeURIComponent(encoded));
  const reason = prompt(`Report "${ch.name}"?\n\nDescribe the issue:`);
  if (!reason?.trim()) return;
  const { ok } = await safeFetch('/api/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: ch.id, xmltv_id: ch.xmltv_id, channel_name: ch.name, site: ch.site, reason: reason.trim() })
  });
  alert(ok ? 'Report submitted!' : 'Failed to submit report.');
}

// ============================================================================
// Rendering
// ============================================================================

function renderChannels(channels) {
  if (!channels.length) {
    el.channelList.classList.add('hidden');
    el.noResults.classList.remove('hidden');
    return;
  }
  el.channelList.classList.remove('hidden');
  el.noResults.classList.add('hidden');

  el.channelList.innerHTML = channels.map(ch => {
    const logo = getLogoSrc(ch);
    const line = xmlLine(ch);
    const encoded = encodeURIComponent(JSON.stringify(ch));
    return `
    <div class="card p-5">
      <div class="flex flex-col md:flex-row gap-4">
        <div class="flex-shrink-0">
          <img src="${escHtml(logo)}" alt="${escHtml(ch.name)} logo"
               class="w-16 h-16 object-contain bg-[var(--bg-1)] border border-[var(--line-soft)] rounded-lg p-2"
               onerror="handleLogoError(this, ${JSON.stringify(ch.name)})"
               loading="lazy">
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
            <h3 class="font-display text-lg font-medium text-[var(--text-hi)] truncate">${escHtml(ch.name)}</h3>
            <span class="font-mono-tag text-xs text-[var(--text-lo)] truncate">${escHtml(ch.xmltv_id)}</span>
          </div>
          <div class="flex flex-wrap gap-2 mb-3">
            <span class="badge badge-country">${escHtml(ch.country)}</span>
            <span class="badge badge-site">${escHtml(ch.site)}</span>
            <span class="badge badge-lang">${escHtml(ch.lang).toUpperCase()}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <button data-variant="btn-amber" onclick='copyToClipboard(${JSON.stringify(line)}, this, "source")' class="btn btn-amber">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
              Copy source
            </button>
            <button data-variant="btn-cyan" onclick='copyToClipboard(${JSON.stringify(ch.xmltv_id)}, this, "xmltv")' class="btn btn-cyan">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path></svg>
              XMLTV ID
            </button>
            <button data-variant="btn-violet" onclick='copyToClipboard(${JSON.stringify(ch.site_id)}, this, "siteid")' class="btn btn-violet">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path></svg>
              Site ID
            </button>
            <button onclick='reportChannel("${encoded}")' class="btn btn-danger-outline">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
              Report
            </button>
          </div>
        </div>
      </div>
      <div class="mt-4 p-3 bg-[var(--bg-1)] border border-[var(--line-soft)] rounded-lg overflow-x-auto">
        <code class="xml-line text-xs text-[var(--cyan)]">${escHtml(line)}</code>
      </div>
    </div>`;
  }).join('');
}

function renderPagination() {
  let cont = document.getElementById('pagination');
  if (!cont) {
    cont = document.createElement('div');
    cont.id = 'pagination';
    el.channelList.parentNode.insertBefore(cont, el.channelList.nextSibling);
  }
  if (totalPages <= 1) { cont.classList.add('hidden'); return; }
  cont.classList.remove('hidden');

  let s = Math.max(1, currentPage - 2);
  let e = Math.min(totalPages, s + 4);
  if (e - s < 4) s = Math.max(1, e - 4);

  const pageBtn = (label, page, opts = {}) => {
    const active = page === currentPage;
    const cls = active ? 'btn-amber' : 'btn-ghost';
    const disabled = opts.disabled ? 'disabled' : '';
    return `<button onclick="goToPage(${page})" ${disabled} class="btn ${cls}">${label}</button>`;
  };

  let html = '<div class="flex justify-center items-center gap-2 mt-6 flex-wrap">';
  html += pageBtn('Previous', currentPage - 1, { disabled: currentPage === 1 });
  if (s > 1) { html += pageBtn('1', 1); if (s > 2) html += '<span class="text-[var(--text-lo)] px-1">…</span>'; }
  for (let i = s; i <= e; i++) html += pageBtn(String(i), i);
  if (e < totalPages) { if (e < totalPages - 1) html += '<span class="text-[var(--text-lo)] px-1">…</span>'; html += pageBtn(String(totalPages), totalPages); }
  html += pageBtn('Next', currentPage + 1, { disabled: currentPage === totalPages });
  html += '</div>';
  cont.innerHTML = html;
}

function goToPage(p) {
  if (p < 1 || p > totalPages) return;
  currentPage = p;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  fetchChannels();
}

function escHtml(t) {
  if (t == null) return '';
  const d = document.createElement('div');
  d.textContent = String(t);
  return d.innerHTML;
}

function resetFilters() {
  el.searchInput.value = '';
  siteCombo.reset();
  langCombo.reset();
  currentPage = 1;
  fetchChannels();
}

let searchTimer;
function handleFilterChange() {
  currentPage = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(fetchChannels, 300);
}

// ============================================================================
// Refresh — runs in the background on the server; we poll /api/stats.
// ============================================================================
let refreshPollTimer = null;

async function refreshData() {
  el.refreshBtn.disabled = true;
  el.refreshBtn.textContent = 'Starting refresh…';

  const { ok, data } = await safeFetch('/api/refresh', { method: 'POST' });

  if (!ok) {
    alert('Failed to start refresh: ' + (data.message || data.error || 'Unknown error'));
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = 'Refresh data';
    return;
  }

  if (data.refreshRunning === false) {
    await fetchStats(); await fetchFilters(); currentPage = 1; await fetchChannels();
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = 'Refresh data';
    return;
  }

  el.refreshBtn.textContent = 'Refreshing… (polling)';
  pollRefreshStatus();
}

function pollRefreshStatus() {
  clearTimeout(refreshPollTimer);
  refreshPollTimer = setTimeout(async () => {
    const { data } = await safeFetch('/api/stats');

    if (data.refreshRunning) {
      const progress = data.refreshProgress || '';
      el.refreshBtn.textContent = `Refreshing… ${progress}`;
      pollRefreshStatus();
    } else {
      el.refreshBtn.disabled = false;
      el.refreshBtn.textContent = 'Refresh data';

      if (data.lastError) {
        alert('Refresh failed: ' + data.lastError);
      } else {
        const freshStats = await fetchStats();
        await fetchFilters();
        currentPage = 1;
        await fetchChannels();
        alert(`Refresh complete! ${(freshStats.totalChannels || 0).toLocaleString()} channels loaded.`);
      }
    }
  }, 5000);
}

// ============================================================================
// Init
// ============================================================================
el.searchInput.addEventListener('input', handleFilterChange);
el.resetBtn.addEventListener('click', resetFilters);
el.refreshBtn.addEventListener('click', refreshData);

(async function init() {
  const stats = await fetchStats();

  if (stats.refreshRunning) {
    el.refreshBtn.disabled = true;
    el.refreshBtn.textContent = 'Refreshing… (polling)';
    pollRefreshStatus();
  }

  await fetchFilters();
  await fetchChannels();
})();
