// State
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
  siteFilter: document.getElementById('siteFilter'),
  langFilter: document.getElementById('langFilter'),
  resetBtn: document.getElementById('resetBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  channelCount: document.getElementById('channelCount'),
  resultCount: document.getElementById('resultCount'),
  totalCount: document.getElementById('totalCount'),
  lastUpdate: document.getElementById('lastUpdate'),
};

async function fetchStats() {
  try {
    const data = await fetch('/api/stats').then(r => r.json());
    el.channelCount.textContent = data.totalChannels.toLocaleString();
    el.totalCount.textContent = data.totalChannels.toLocaleString();
    if (data.lastUpdate) el.lastUpdate.textContent = new Date(data.lastUpdate).toLocaleString();
    return data;
  } catch (e) {
    console.error('fetchStats:', e);
    return {};
  }
}

async function fetchFilters() {
  try {
    const data = await fetch('/api/filters').then(r => r.json());
    el.siteFilter.innerHTML = '<option value="">All Sites</option>';
    (data.sites || []).forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      el.siteFilter.appendChild(o);
    });
    el.langFilter.innerHTML = '<option value="">All Languages</option>';
    (data.languages || []).forEach(l => {
      const o = document.createElement('option');
      o.value = l; o.textContent = l.toUpperCase();
      el.langFilter.appendChild(o);
    });
  } catch (e) {
    console.error('fetchFilters:', e);
  }
}

async function fetchChannels() {
  try {
    const params = new URLSearchParams({ page: currentPage, limit: pageSize });
    const search = el.searchInput.value;
    const site = el.siteFilter.value;
    const lang = el.langFilter.value;
    if (search) params.append('search', search);
    if (site) params.append('site', site);
    if (lang) params.append('lang', lang);

    const resp = await fetch(`/api/channels?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || 'Server error');

    totalPages = data.pagination.totalPages;
    totalCount = data.pagination.totalCount;
    el.resultCount.textContent = totalCount.toLocaleString();

    renderChannels(data.channels);
    renderPagination();

    if (data.lastUpdate) el.lastUpdate.textContent = new Date(data.lastUpdate).toLocaleString();
    el.loading.classList.add('hidden');
    el.content.classList.remove('hidden');
  } catch (e) {
    console.error('fetchChannels:', e);
    el.loading.innerHTML = `
      <div class="text-white text-center">
        <p class="text-xl mb-2">Failed to load channels</p>
        <p class="text-sm text-blue-300 mb-4">${escHtml(e.message)}</p>
        <button onclick="location.reload()" class="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg">Retry</button>
      </div>`;
  }
}

function xmlLine(ch) {
  return `<channel site="${ch.site}" lang="${ch.lang}" xmltv_id="${ch.xmltv_id}" site_id="${ch.site_id}">${ch.name}</channel>`;
}

/**
 * Get logo src for a channel.
 * 1. Use the URL stored in DB — set at import time from logos-manifest.json
 *    (these are tvlogos.austheim.app/countries/... URLs)
 * 2. Fallback: derive a slug-based URL from channel name + country code
 */
function getLogoSrc(ch) {
  if (ch.logo && ch.logo.trim()) return ch.logo;

  // Derive slug fallback: "Frikanalen" + xmltv "Frikanalen.no@SD" -> frikanalen-no
  const ccMatch = (ch.xmltv_id || '').match(/\.([a-z]{2,3})(?:@|$)/i);
  const cc = ccMatch ? ccMatch[1].toLowerCase() : '';
  const slug = ch.name.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const withCc = cc ? `${slug}-${cc}` : slug;

  // We don't know the country subfolder, so try a few likely paths on tvlogos.austheim.app
  // The server-side match is more reliable; this is just a browser-side last attempt
  return `https://tvlogos.austheim.app/logos/${withCc}.png`;
}

function makePlaceholder(name) {
  const initials = (name || '??').substring(0, 2).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">
    <rect width="80" height="80" rx="8" fill="#1e293b"/>
    <text x="40" y="50" font-family="system-ui,sans-serif" font-size="24" font-weight="bold"
          text-anchor="middle" fill="#667eea">${initials}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function handleLogoError(img, name, xmltvId) {
  const tried = parseInt(img.getAttribute('data-tried') || '0');
  img.setAttribute('data-tried', tried + 1);

  if (tried === 0) {
    // Try name-only slug
    const slug = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    img.src = `https://tvlogos.austheim.app/logos/${slug}.png`;
  } else if (tried === 1) {
    // Try xmltv_id-derived slug
    const slug = (xmltvId || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    img.src = `https://tvlogos.austheim.app/logos/${slug}.png`;
  } else {
    // Final: SVG initials placeholder
    img.src = makePlaceholder(name);
    img.onerror = null;
  }
}

async function copyToClipboard(text, btn, type) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.innerHTML;
    const labels = { source: 'Copied!', xmltv: 'Copied XMLTV!', siteid: 'Copied ID!' };
    const colors = {
      source: ['bg-blue-600', 'hover:bg-blue-700'],
      xmltv: ['bg-purple-600', 'hover:bg-purple-700'],
      siteid: ['bg-orange-600', 'hover:bg-orange-700'],
    };
    btn.innerHTML = `✓ ${labels[type]}`;
    btn.classList.add('bg-green-600');
    colors[type].forEach(c => btn.classList.remove(c));
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.classList.remove('bg-green-600');
      colors[type].forEach(c => btn.classList.add(c));
    }, 2000);
  } catch (e) { alert('Copy failed'); }
}

async function reportChannel(encoded) {
  const ch = JSON.parse(decodeURIComponent(encoded));
  const reason = prompt(`Report "${ch.name}"?\n\nDescribe the issue:`);
  if (!reason?.trim()) return;
  try {
    const r = await fetch('/api/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: ch.id, xmltv_id: ch.xmltv_id, channel_name: ch.name, site: ch.site, reason: reason.trim() })
    });
    alert(r.ok ? 'Report submitted!' : 'Failed to submit report.');
  } catch (e) { alert('Failed.'); }
}

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
    <div class="bg-white/10 backdrop-blur-lg rounded-xl p-5 shadow-lg border border-white/20 hover:bg-white/15 transition">
      <div class="flex flex-col md:flex-row gap-4">
        <div class="flex-shrink-0">
          <img src="${escHtml(logo)}"
               alt="${escHtml(ch.name)}"
               class="w-20 h-20 object-contain bg-white/5 rounded-lg p-2"
               onerror="handleLogoError(this, ${JSON.stringify(ch.name)}, ${JSON.stringify(ch.xmltv_id)})"
               loading="lazy">
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="text-xl font-semibold text-white mb-2 truncate">${escHtml(ch.name)}</h3>
          <div class="flex flex-wrap gap-2 text-sm mb-3">
            <span class="px-3 py-1 bg-blue-500/30 text-blue-100 rounded-full">${escHtml(ch.country)}</span>
            <span class="px-3 py-1 bg-purple-500/30 text-purple-100 rounded-full">${escHtml(ch.site)}</span>
            <span class="px-3 py-1 bg-green-500/30 text-green-100 rounded-full">${escHtml(ch.lang).toUpperCase()}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <button onclick='copyToClipboard(${JSON.stringify(line)}, this, "source")'
                    class="flex items-center gap-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
              </svg>
              Copy Source
            </button>
            <button onclick='copyToClipboard(${JSON.stringify(ch.xmltv_id)}, this, "xmltv")'
                    class="flex items-center gap-1 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path>
              </svg>
              XMLTV ID
            </button>
            <button onclick='copyToClipboard(${JSON.stringify(ch.site_id)}, this, "siteid")'
                    class="flex items-center gap-1 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-sm rounded-lg transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
              </svg>
              Site ID
            </button>
            <button onclick='reportChannel("${encoded}")'
                    class="flex items-center gap-1 px-4 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-300 text-sm rounded-lg transition border border-red-500/30">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
              </svg>
              Report
            </button>
          </div>
        </div>
      </div>
      <div class="mt-4 p-3 bg-black/30 rounded-lg overflow-x-auto">
        <code class="text-xs text-green-300 font-mono">${escHtml(line)}</code>
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

  let html = '<div class="flex justify-center items-center gap-2 mt-6 flex-wrap">';
  html += `<button onclick="goToPage(${currentPage-1})" ${currentPage===1?'disabled':''} class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition">Previous</button>`;
  if (s > 1) { html += `<button onclick="goToPage(1)" class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition">1</button>`; if (s > 2) html += '<span class="text-white px-2">…</span>'; }
  for (let i = s; i <= e; i++) html += `<button onclick="goToPage(${i})" class="px-4 py-2 ${i===currentPage?'bg-blue-600':'bg-white/10'} text-white rounded-lg hover:bg-white/20 transition">${i}</button>`;
  if (e < totalPages) { if (e < totalPages-1) html += '<span class="text-white px-2">…</span>'; html += `<button onclick="goToPage(${totalPages})" class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition">${totalPages}</button>`; }
  html += `<button onclick="goToPage(${currentPage+1})" ${currentPage===totalPages?'disabled':''} class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition">Next</button>`;
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
  el.searchInput.value = ''; el.siteFilter.value = ''; el.langFilter.value = '';
  currentPage = 1; fetchChannels();
}

let searchTimer;
function handleFilterChange() {
  currentPage = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(fetchChannels, 300);
}

async function refreshData() {
  el.refreshBtn.disabled = true;
  el.refreshBtn.textContent = 'Refreshing… (2-10 min)';
  try {
    const resp = await fetch('/api/refresh', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      await fetchStats(); await fetchFilters(); currentPage = 1; await fetchChannels();
      alert(`Refreshed! ${data.channelCount.toLocaleString()} channels loaded.`);
    } else {
      alert('Refresh failed: ' + (data.message || data.error));
    }
  } catch (e) {
    alert('Refresh failed: ' + e.message);
  } finally {
    el.refreshBtn.disabled = false;
    el.refreshBtn.textContent = 'Refresh Data';
  }
}

el.searchInput.addEventListener('input', handleFilterChange);
el.siteFilter.addEventListener('change', handleFilterChange);
el.langFilter.addEventListener('change', handleFilterChange);
el.resetBtn.addEventListener('click', resetFilters);
el.refreshBtn.addEventListener('click', refreshData);

(async function init() {
  await fetchStats();
  await fetchFilters();
  await fetchChannels();
})();
