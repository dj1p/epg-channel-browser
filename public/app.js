// State management
let currentPage = 1;
let totalPages = 1;
let totalCount = 0;
const pageSize = 50;
let sites = [];
let languages = [];

// DOM elements
const elements = {
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
  lastUpdate: document.getElementById('lastUpdate')
};

// Fetch filters
async function fetchFilters() {
  try {
    const response = await fetch('/api/filters');
    const data = await response.json();
    
    sites = data.sites;
    languages = data.languages;
    
    populateFilters();
  } catch (error) {
    console.error('Error fetching filters:', error);
  }
}

// Fetch stats
async function fetchStats() {
  try {
    const response = await fetch('/api/stats');
    const data = await response.json();
    
    elements.channelCount.textContent = data.totalChannels.toLocaleString();
    elements.totalCount.textContent = data.totalChannels.toLocaleString();
    
    if (data.lastUpdate) {
      elements.lastUpdate.textContent = new Date(data.lastUpdate).toLocaleString();
    }
  } catch (error) {
    console.error('Error fetching stats:', error);
  }
}

// Fetch channels from API
async function fetchChannels() {
  try {
    const searchTerm = elements.searchInput.value;
    const selectedSite = elements.siteFilter.value;
    const selectedLang = elements.langFilter.value;
    
    const params = new URLSearchParams({
      page: currentPage,
      limit: pageSize
    });
    
    if (searchTerm) params.append('search', searchTerm);
    if (selectedSite) params.append('site', selectedSite);
    if (selectedLang) params.append('lang', selectedLang);
    
    const response = await fetch(`/api/channels?${params}`);
    const data = await response.json();
    
    totalPages = data.pagination.totalPages;
    totalCount = data.pagination.totalCount;
    
    updateCounts(data.pagination.totalCount);
    renderChannels(data.channels);
    renderPagination();
    
    if (data.lastUpdate) {
      elements.lastUpdate.textContent = new Date(data.lastUpdate).toLocaleString();
    }
    
    // Show content, hide loading
    elements.loading.classList.add('hidden');
    elements.content.classList.remove('hidden');
    
  } catch (error) {
    console.error('Error fetching channels:', error);
    elements.loading.innerHTML = `
      <div class="text-white text-center">
        <p class="text-xl mb-4">Failed to load channels</p>
        <button onclick="location.reload()" class="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg">
          Retry
        </button>
      </div>
    `;
  }
}

// Populate filter dropdowns
function populateFilters() {
  elements.siteFilter.innerHTML = '<option value="">All Sites</option>';
  sites.forEach(site => {
    const option = document.createElement('option');
    option.value = site;
    option.textContent = site;
    elements.siteFilter.appendChild(option);
  });
  
  elements.langFilter.innerHTML = '<option value="">All Languages</option>';
  languages.forEach(lang => {
    const option = document.createElement('option');
    option.value = lang;
    option.textContent = lang.toUpperCase();
    elements.langFilter.appendChild(option);
  });
}

// Update counts
function updateCounts(resultCount) {
  elements.resultCount.textContent = resultCount.toLocaleString();
}

// Generate XML line
function generateXMLLine(channel) {
  return `<channel site="${channel.site}" lang="${channel.lang}" xmltv_id="${channel.xmltv_id}" site_id="${channel.site_id}">${channel.name}</channel>`;
}

// Get logo URL from tvlogos.austheim.app
function getLogoUrl(channelName, xmltvId) {
  // Clean channel name for logo matching
  const cleanName = channelName.replace(/[^\w\s]/gi, '').trim().replace(/\s+/g, '-').toLowerCase();
  return `https://tvlogos.austheim.app/logos/${cleanName}.png`;
}

// Copy to clipboard with animation
async function copyToClipboard(text, button, type = 'source') {
  try {
    await navigator.clipboard.writeText(text);
    
    const originalHTML = button.innerHTML;
    const messages = {
      source: 'Copied Source!',
      xmltv: 'Copied XMLTV ID!',
      siteid: 'Copied Site ID!'
    };
    
    button.innerHTML = `
      <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
      </svg>
      ${messages[type]}
    `;
    button.classList.add('bg-green-600');
    button.classList.remove('bg-blue-600', 'bg-purple-600', 'bg-orange-600', 'hover:bg-blue-700', 'hover:bg-purple-700', 'hover:bg-orange-700');
    
    setTimeout(() => {
      button.innerHTML = originalHTML;
      button.classList.remove('bg-green-600');
      if (type === 'source') {
        button.classList.add('bg-blue-600', 'hover:bg-blue-700');
      } else if (type === 'xmltv') {
        button.classList.add('bg-purple-600', 'hover:bg-purple-700');
      } else {
        button.classList.add('bg-orange-600', 'hover:bg-orange-700');
      }
    }, 2000);
    
  } catch (error) {
    console.error('Failed to copy:', error);
    alert('Failed to copy to clipboard');
  }
}

// Report channel issue
async function reportChannel(channel) {
  const reason = prompt(`Report issue with "${channel.name}"?\n\nPlease describe the problem:`);
  
  if (!reason || reason.trim() === '') return;
  
  try {
    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: channel.id,
        xmltv_id: channel.xmltv_id,
        channel_name: channel.name,
        site: channel.site,
        reason: reason.trim()
      })
    });
    
    if (response.ok) {
      alert('Thank you! Your report has been submitted.');
    } else {
      alert('Failed to submit report. Please try again.');
    }
  } catch (error) {
    console.error('Error reporting channel:', error);
    alert('Failed to submit report. Please try again.');
  }
}

// Render channels
function renderChannels(channels) {
  if (channels.length === 0) {
    elements.channelList.classList.add('hidden');
    elements.noResults.classList.remove('hidden');
    return;
  }
  
  elements.channelList.classList.remove('hidden');
  elements.noResults.classList.add('hidden');
  
  elements.channelList.innerHTML = channels.map((channel) => {
    const logoUrl = getLogoUrl(channel.name, channel.xmltv_id);
    
    return `
    <div class="bg-white/10 backdrop-blur-lg rounded-xl p-5 shadow-lg border border-white/20 hover:bg-white/15 transition">
      <div class="flex flex-col md:flex-row gap-4">
        <!-- Logo Section -->
        <div class="flex-shrink-0">
          <img src="${logoUrl}" 
               alt="${escapeHtml(channel.name)}" 
               class="w-20 h-20 object-contain bg-white/5 rounded-lg p-2"
               onerror="this.src='https://via.placeholder.com/80/1e293b/667eea?text=TV'"
               loading="lazy">
        </div>
        
        <!-- Content Section -->
        <div class="flex-1 min-w-0">
          <h3 class="text-xl font-semibold text-white mb-2 truncate">
            ${escapeHtml(channel.name)}
          </h3>
          
          <div class="flex flex-wrap gap-2 text-sm mb-3">
            <span class="px-3 py-1 bg-blue-500/30 text-blue-100 rounded-full">
              ${escapeHtml(channel.country)}
            </span>
            <span class="px-3 py-1 bg-purple-500/30 text-purple-100 rounded-full">
              ${escapeHtml(channel.site)}
            </span>
            <span class="px-3 py-1 bg-green-500/30 text-green-100 rounded-full">
              ${escapeHtml(channel.lang).toUpperCase()}
            </span>
          </div>

          <!-- Copy Buttons -->
          <div class="flex flex-wrap gap-2">
            <button onclick='copyToClipboard(\`${escapeHtml(generateXMLLine(channel))}\`, this, "source")' 
                    class="flex items-center gap-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
              </svg>
              Copy Source
            </button>
            
            <button onclick='copyToClipboard("${escapeHtml(channel.xmltv_id)}", this, "xmltv")' 
                    class="flex items-center gap-1 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path>
              </svg>
              XMLTV ID
            </button>
            
            <button onclick='copyToClipboard("${escapeHtml(channel.site_id)}", this, "siteid")' 
                    class="flex items-center gap-1 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white text-sm rounded-lg transition">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path>
              </svg>
              Site ID
            </button>

            <button onclick='reportChannel(${JSON.stringify(channel).replace(/'/g, "\\'")})' 
                    class="flex items-center gap-1 px-4 py-2 bg-red-600/20 hover:bg-red-600/40 text-red-300 text-sm rounded-lg transition border border-red-500/30">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
              </svg>
              Report
            </button>
          </div>
        </div>
      </div>

      <!-- XML Preview -->
      <div class="mt-4 p-3 bg-black/30 rounded-lg overflow-x-auto">
        <div class="flex justify-between items-start gap-2 mb-2">
          <code class="text-xs text-green-300 font-mono flex-1">${escapeHtml(generateXMLLine(channel))}</code>
          <a href="https://tvlogos.austheim.app" target="_blank" 
             class="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
            </svg>
            Get Logo
          </a>
        </div>
      </div>
    </div>
  `}).join('');
}

// Render pagination
function renderPagination() {
  const paginationContainer = document.getElementById('pagination') || createPaginationContainer();
  
  if (totalPages <= 1) {
    paginationContainer.classList.add('hidden');
    return;
  }
  
  paginationContainer.classList.remove('hidden');
  
  const maxButtons = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  
  if (endPage - startPage < maxButtons - 1) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }
  
  let html = '<div class="flex justify-center items-center gap-2 mt-6 flex-wrap">';
  
  html += `
    <button onclick="goToPage(${currentPage - 1})" 
            ${currentPage === 1 ? 'disabled' : ''}
            class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition">
      Previous
    </button>
  `;
  
  if (startPage > 1) {
    html += `<button onclick="goToPage(1)" class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition">1</button>`;
    if (startPage > 2) html += '<span class="text-white px-2">...</span>';
  }
  
  for (let i = startPage; i <= endPage; i++) {
    html += `
      <button onclick="goToPage(${i})" 
              class="px-4 py-2 ${i === currentPage ? 'bg-blue-600' : 'bg-white/10'} text-white rounded-lg hover:bg-white/20 transition">
        ${i}
      </button>
    `;
  }
  
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += '<span class="text-white px-2">...</span>';
    html += `<button onclick="goToPage(${totalPages})" class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition">${totalPages}</button>`;
  }
  
  html += `
    <button onclick="goToPage(${currentPage + 1})" 
            ${currentPage === totalPages ? 'disabled' : ''}
            class="px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition">
      Next
    </button>
  `;
  
  html += '</div>';
  paginationContainer.innerHTML = html;
}

function createPaginationContainer() {
  const container = document.createElement('div');
  container.id = 'pagination';
  elements.channelList.parentNode.insertBefore(container, elements.channelList.nextSibling);
  return container;
}

function goToPage(page) {
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  fetchChannels();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function resetFilters() {
  elements.searchInput.value = '';
  elements.siteFilter.value = '';
  elements.langFilter.value = '';
  currentPage = 1;
  fetchChannels();
}

let searchTimeout;
function handleFilterChange() {
  currentPage = 1;
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    fetchChannels();
  }, 300);
}

async function refreshData() {
  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = 'Refreshing...';
  
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    const data = await response.json();
    
    if (data.success) {
      await fetchStats();
      await fetchFilters();
      currentPage = 1;
      await fetchChannels();
      alert(`Successfully refreshed ${data.channelCount.toLocaleString()} channels!`);
    }
  } catch (error) {
    console.error('Error refreshing:', error);
    alert('Failed to refresh data');
  } finally {
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = 'Refresh Data';
  }
}

// Event listeners
elements.searchInput.addEventListener('input', handleFilterChange);
elements.siteFilter.addEventListener('change', handleFilterChange);
elements.langFilter.addEventListener('change', handleFilterChange);
elements.resetBtn.addEventListener('click', resetFilters);
elements.refreshBtn.addEventListener('click', refreshData);

// Initialize
(async function init() {
  await fetchStats();
  await fetchFilters();
  await fetchChannels();
})();
