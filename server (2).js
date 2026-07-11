// server.js
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const EPG_REPO = 'dj1p/epg';
const TVLOGOS_BASE = 'https://tvlogos.austheim.app';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'epg-channels.db');
const db = new Database(dbPath);
console.log(`Database: ${dbPath}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site TEXT NOT NULL,
    lang TEXT NOT NULL,
    xmltv_id TEXT NOT NULL,
    site_id TEXT,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    logo TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_site ON channels(site);
  CREATE INDEX IF NOT EXISTS idx_lang ON channels(lang);
  CREATE INDEX IF NOT EXISTS idx_country ON channels(country);
  CREATE INDEX IF NOT EXISTS idx_name ON channels(name);
  CREATE INDEX IF NOT EXISTS idx_xmltv_id ON channels(xmltv_id);

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER,
    xmltv_id TEXT,
    channel_name TEXT,
    site TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
try { db.exec(`ALTER TABLE channels ADD COLUMN logo TEXT DEFAULT ''`); } catch (e) {}

// Track background refresh state so the UI can poll it
let refreshState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  channelCount: null,
};

const countryMapping = {
  'us': 'United States', 'uk': 'United Kingdom', 'ca': 'Canada',
  'au': 'Australia',     'de': 'Germany',         'fr': 'France',
  'es': 'Spain',         'it': 'Italy',            'nl': 'Netherlands',
  'br': 'Brazil',        'mx': 'Mexico',           'ar': 'Argentina',
  'in': 'India',         'jp': 'Japan',            'kr': 'South Korea',
  'cn': 'China',         'ru': 'Russia',           'se': 'Sweden',
  'no': 'Norway',        'dk': 'Denmark',          'fi': 'Finland',
  'pl': 'Poland',        'tr': 'Turkey',           'za': 'South Africa',
  'nz': 'New Zealand',   'ie': 'Ireland',          'pt': 'Portugal',
  'gr': 'Greece',        'ch': 'Switzerland',      'at': 'Austria',
  'be': 'Belgium',       'cz': 'Czech Republic',   'ro': 'Romania',
  'hu': 'Hungary',       'il': 'Israel',           'ae': 'United Arab Emirates',
  'sg': 'Singapore',     'th': 'Thailand',         'my': 'Malaysia',
  'id': 'Indonesia',     'ph': 'Philippines',      'vn': 'Vietnam',
};

function detectCountry(xmltvId, siteName) {
  // 1. xmltv_id suffix: "CNN.us" -> "us", "Frikanalen.no@SD" -> "no"
  const xmltvCc = (xmltvId.match(/\.([a-z]{2,3})(?:@|$)/i) || [])[1]?.toLowerCase();
  if (xmltvCc && countryMapping[xmltvCc]) {
    return { country: countryMapping[xmltvCc], cc: xmltvCc };
  }

  // 2. Domain parts right-to-left: "gigatv.3bbtv.co.th" -> "th" = Thailand
  //    (avoids false substring matches like "at" inside "gigatv")
  const domainParts = siteName.toLowerCase().replace(/\/.*$/, '').split('.');
  for (let i = domainParts.length - 1; i >= 0; i--) {
    const part = domainParts[i];
    if (part.length === 2 && countryMapping[part]) {
      return { country: countryMapping[part], cc: part };
    }
  }

  // 3. Substring fallback for IDs like "SomeChannel.co.uk"
  for (const [cc, country] of Object.entries(countryMapping)) {
    if (xmltvId.toLowerCase().includes('.' + cc)) {
      return { country, cc };
    }
  }

  return { country: 'International', cc: null };
}

function githubHeaders() {
  const h = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'EPG-Browser/2.0' };
  if (GITHUB_TOKEN) h['Authorization'] = `token ${GITHUB_TOKEN}`;
  return h;
}

async function detectBranch(repo) {
  try {
    const r = await axios.get(`https://api.github.com/repos/${repo}`, { headers: githubHeaders(), timeout: 10000 });
    return r.data.default_branch || 'main';
  } catch (e) {
    for (const b of ['main', 'master']) {
      try {
        await axios.get(`https://api.github.com/repos/${repo}/git/refs/heads/${b}`, { headers: githubHeaders(), timeout: 8000 });
        return b;
      } catch (_) {}
    }
    return 'main';
  }
}

// Shared normalizer -- MUST be used identically on both the manifest keys and
// the query candidates, or matching silently fails. (This used to be defined
// twice: once implicitly -- fetchLogoManifest() only lowercased filenames and
// kept dots/spaces/underscores -- and once explicitly inside findLogo(),
// which strips ALL punctuation to hyphens. Two different slug spaces being
// compared against each other meant almost nothing matched, e.g.
// "CNN.us.png" -> stored as "cnn.us" but looked up as "cnn-us".)
function toSlug(str) {
  return String(str).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function fetchLogoManifest() {
  console.log('Fetching logos-manifest.json from tvlogos.austheim.app...');
  try {
    const resp = await axios.get(`${TVLOGOS_BASE}/logos-manifest.json`, {
      timeout: 30000,
      headers: { 'User-Agent': 'EPG-Browser/2.0' }
    });
    const entries = resp.data.logos || [];

    // Global flat index: slug -> url. Used for cc-suffixed / xmltv-id-based
    // candidates, and as a fallback when a manifest entry's "country" folder
    // doesn't line up with what detectCountry() guesses for a channel.
    const logoMap = {};

    // Country-scoped index: countrySlug -> { nameSlug -> url }. This is what
    // actually rescues countries like Thailand, where filenames in
    // tvlogos/countries/thailand/ are things like "ALTV.png" or
    // "AmarinTV_NEW512.png" -- no "-th" suffix at all, so they can NEVER be
    // found by the cc-suffixed candidates the global index relies on. Since
    // the manifest tells us which country folder each logo came from, we can
    // scope the search to just that country and match on plain name alone
    // (or a prefix match, for files with junk resolution/version suffixes),
    // without risking cross-country false positives the way an unscoped
    // prefix match over the whole flat index would.
    const logosByCountry = {};

    // tvlogos accepts more than PNG (a handful of channels only ever got a
    // .jpg uploaded) -- the old filter silently dropped anything else.
    const IMAGE_EXT = /\.(png|jpe?g|webp|svg|gif)$/i;

    let skipped = 0;
    for (const entry of entries) {
      if (!entry?.name || !IMAGE_EXT.test(entry.name) || !entry.path) { skipped++; continue; }
      const rawStem = entry.name.replace(IMAGE_EXT, '');
      const stem = toSlug(rawStem);
      if (!stem) { skipped++; continue; }
      const url = `${TVLOGOS_BASE}${entry.path}`;

      // First filename to claim a slug wins -- don't let a later collision
      // silently overwrite an earlier good match.
      if (!logoMap[stem]) logoMap[stem] = url;

      // "country" in the manifest can include a subfolder, e.g.
      // "united-kingdom/hd" or "germany/sky-sport/old" -- keep only the top
      // segment so it lines up with the top-level folder (and with what
      // detectCountry() will produce).
      const countrySlug = toSlug(String(entry.country || '').split('/')[0]);
      if (countrySlug) {
        if (!logosByCountry[countrySlug]) logosByCountry[countrySlug] = {};
        if (!logosByCountry[countrySlug][stem]) logosByCountry[countrySlug][stem] = url;
      }
    }
    console.log(`Logo manifest loaded: ${Object.keys(logoMap).length} logos across ${Object.keys(logosByCountry).length} countries (${skipped} entries skipped -- bad name/extension)`);
    return { logoMap, logosByCountry };
  } catch (err) {
    console.warn('Could not fetch logo manifest:', err.message);
    return { logoMap: {}, logosByCountry: {} };
  }
}

function findLogo(logoMap, logosByCountry, channelName, xmltvId, cc, country) {
  if (!logoMap || Object.keys(logoMap).length === 0) return '';

  const xmltvCc = (xmltvId.match(/\.([a-z]{2,3})(?:@|$)/i) || [])[1]?.toLowerCase();
  const effectiveCc = xmltvCc || cc;
  const xmltvBase = xmltvId.replace(/\.[a-z]{2,3}(@.*)?$/i, '');
  const nameSlug = toSlug(channelName);
  const xmltvSlug = toSlug(xmltvBase);

  // 1. Country-scoped match first -- highest confidence, and the only path
  // that can find filenames with no country-code suffix at all.
  const countrySlug = country ? toSlug(country) : '';
  const countryMap = countrySlug ? logosByCountry[countrySlug] : null;
  if (countryMap) {
    if (nameSlug && countryMap[nameSlug]) return countryMap[nameSlug];
    if (xmltvSlug && xmltvSlug !== nameSlug && countryMap[xmltvSlug]) return countryMap[xmltvSlug];

    // Prefix match within the same country only, to catch filenames with a
    // trailing version/resolution artifact (e.g. "amarintv-new512" for a
    // channel literally named "AmarinTV"). Length guard avoids short names
    // like "ch2" spuriously prefix-matching unrelated longer entries.
    if (nameSlug.length >= 4) {
      const key = Object.keys(countryMap).find(k => k.startsWith(nameSlug));
      if (key) return countryMap[key];
    }
  }

  // 2. Global candidates -- cc-suffixed / xmltv-id-based. Covers well-formed
  // filenames (name-cc.png) whose manifest "country" folder didn't match
  // what detectCountry() guessed (naming drift, aliasing, etc).
  const candidates = [];
  if (effectiveCc) {
    candidates.push(`${nameSlug}-${effectiveCc}`);
    if (xmltvSlug && xmltvSlug !== nameSlug) candidates.push(`${xmltvSlug}-${effectiveCc}`);
  }
  if (xmltvId) candidates.push(toSlug(xmltvId));
  candidates.push(nameSlug);
  if (xmltvSlug && xmltvSlug !== nameSlug) candidates.push(xmltvSlug);

  for (const c of candidates) {
    if (c && logoMap[c]) return logoMap[c];
  }

  // 3. Unscoped prefix match, but only when we have a cc -- keeps the blast
  // radius small and avoids wrong-country matches.
  if (effectiveCc) {
    const hit = Object.keys(logoMap).find(k =>
      k.startsWith(nameSlug + '-') && k.endsWith('-' + effectiveCc)
    );
    if (hit) return logoMap[hit];
  }

  // 4. Last resort: a same-brand logo filed under a DIFFERENT country than
  // the one we detected. This specifically rescues internationally
  // franchised channels (HBO, Discovery Channel, Nickelodeon, Cartoon
  // Network...) that are relayed in many countries but whose logo only
  // exists in the manifest under one or two "reference" markets (very often
  // UK). A UK Discovery Channel logo is a reasonable stand-in for a Thai
  // relay of Discovery Channel -- this tool is for visual identification,
  // not authoritative regional broadcast art, so a same-brand logo from a
  // different market beats no logo at all. Length guard avoids short/generic
  // names (e.g. "CH8") from matching unrelated entries.
  if (nameSlug.length >= 5) {
    const hit = Object.keys(logoMap).find(k => k.startsWith(nameSlug + '-'));
    if (hit) return logoMap[hit];
  }

  return '';
}

async function fetchAndStoreChannels() {
  console.log('=== Starting channel fetch ===');
  if (!GITHUB_TOKEN) {
    console.warn('No GITHUB_TOKEN — only 60 GitHub API req/hour. Set in Coolify env vars for 5000/hr.');
  }

  const setMeta = db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');

  const [epgBranch, logoData] = await Promise.all([
    detectBranch(EPG_REPO),
    fetchLogoManifest(),
  ]);
  const { logoMap, logosByCountry } = logoData;
  console.log(`EPG branch: ${epgBranch}`);

  let treeResp;
  try {
    treeResp = await axios.get(
      `https://api.github.com/repos/${EPG_REPO}/git/trees/${epgBranch}?recursive=1`,
      { headers: githubHeaders(), timeout: 30000 }
    );
  } catch (err) {
    const status = err.response?.status;
    const reset = err.response?.headers?.['x-ratelimit-reset'];
    const resetTime = reset ? new Date(reset * 1000).toISOString() : 'unknown';
    if (status === 403 || status === 429) throw new Error(`GitHub rate limited — resets at ${resetTime}. Set GITHUB_TOKEN env var.`);
    if (status === 404) throw new Error(`Branch '${epgBranch}' not found in ${EPG_REPO}.`);
    throw new Error(`GitHub API error: ${err.message}`);
  }

  if (treeResp.data.truncated) console.warn('GitHub tree response truncated.');

  const channelFiles = treeResp.data.tree.filter(f =>
    f.path.startsWith('sites/') && f.path.endsWith('.channels.xml') && f.type === 'blob'
  );
  console.log(`Found ${channelFiles.length} channel files`);
  if (channelFiles.length === 0) throw new Error('No channel files found.');

  const remaining = treeResp.headers?.['x-ratelimit-remaining'];
  console.log(`Rate limit remaining: ${remaining}/${treeResp.headers?.['x-ratelimit-limit']}`);

  db.exec('DELETE FROM channels');
  const insert = db.prepare(
    `INSERT INTO channels (site, lang, xmltv_id, site_id, name, country, logo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const parser = new xml2js.Parser();

  // Some sites have more than one *.channels.xml file (e.g. gigatv.3bbtv.co.th
  // has "gigatv.3bbtv.co.th.channels.xml", "..._th.channels.xml", and
  // "...config_th.channels.xml" all sitting in the same directory -- stale or
  // renamed snapshots left behind in the community repo). All of them match
  // the ".channels.xml" filter and get processed, so the same channel can
  // show up 2-3x. This is different from sites like dstv.com or pluto.tv,
  // which *legitimately* have many files -- one genuinely distinct channel
  // lineup per country/region. So we can't just skip files by name; instead
  // we dedup on exact content: if the same (site, site_id, xmltv_id, lang,
  // name) tuple has already been inserted this run, skip it, regardless of
  // which file it came from.
  const seenChannels = new Set();

  let total = 0, ok = 0, errors = 0, duplicates = 0;

  // Process files sequentially — avoids memory spikes from parallel XML parsing
  // that caused the container to be killed mid-run. With a token this still
  // completes in ~10-15 min for 500+ files.
  for (let i = 0; i < channelFiles.length; i++) {
    const file = channelFiles[i];
    try {
      const url = `https://raw.githubusercontent.com/${EPG_REPO}/${epgBranch}/${file.path}`;
      const xml = await axios.get(url, { headers: { 'User-Agent': 'EPG-Browser/2.0' }, timeout: 15000 });
      const parsed = await parser.parseStringPromise(xml.data);
      if (parsed.channels?.channel) {
        const siteName = file.path.split('/')[1];
        db.transaction((channels) => {
          for (const ch of channels) {
            const xmltvId = ch.$.xmltv_id || '';
            const name = ch._ || ch.$.xmltv_id || 'Unknown';
            const site = ch.$.site || siteName;
            const lang = ch.$.lang || 'en';
            const siteId = ch.$.site_id || '';

            const dedupKey = `${site}\u0000${siteId}\u0000${xmltvId}\u0000${lang}\u0000${name}`;
            if (seenChannels.has(dedupKey)) { duplicates++; continue; }
            seenChannels.add(dedupKey);

            const { country, cc } = detectCountry(xmltvId, siteName);
            const logo = findLogo(logoMap, logosByCountry, name, xmltvId, cc, country);
            insert.run(site, lang, xmltvId, siteId, name, country, logo);
            total++;
          }
        })(parsed.channels.channel);
        ok++;
      }
    } catch (err) {
      errors++;
      if ([403, 429].includes(err.response?.status)) {
        console.error(`Rate limited on ${file.path}`);
      } else {
        console.error(`Error on ${file.path}: ${err.message}`);
      }
    }

    // Update progress every 10 files
    if (i % 10 === 0) {
      const pct = Math.round((i / channelFiles.length) * 100);
      setMeta.run('refresh_progress', `${pct}% — ${i}/${channelFiles.length} files, ${total} channels`);
      setMeta.run('files_processed', ok.toString());
      setMeta.run('files_errored', errors.toString());
      if (i % 50 === 0) {
        console.log(`Progress: ${i}/${channelFiles.length} files | ${total} channels | ${errors} errors`);
      }
    }
  }

  setMeta.run('last_update', new Date().toISOString());
  setMeta.run('files_processed', ok.toString());
  setMeta.run('files_errored', errors.toString());
  setMeta.run('last_error', '');
  setMeta.run('refresh_progress', 'complete');
  console.log(`=== Done: ${total} channels from ${ok}/${channelFiles.length} files (${errors} errors, ${duplicates} exact duplicates skipped) ===`);
  return total;
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/channels', (req, res) => {
  try {
    const { search, site, lang, page = 1, limit = 50 } = req.query;
    let q = 'SELECT * FROM channels WHERE 1=1';
    const p = [];
    if (search) {
      q += ' AND (name LIKE ? OR country LIKE ? OR xmltv_id LIKE ? OR site LIKE ?)';
      const s = `%${search}%`; p.push(s, s, s, s);
    }
    if (site) { q += ' AND site = ?'; p.push(site); }
    if (lang) { q += ' AND lang = ?'; p.push(lang); }

    const totalCount = db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) as count')).get(...p).count;
    q += ' ORDER BY name LIMIT ? OFFSET ?';
    p.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    res.json({
      channels: db.prepare(q).all(...p),
      pagination: { page: parseInt(page), limit: parseInt(limit), totalCount, totalPages: Math.ceil(totalCount / parseInt(limit)) },
      lastUpdate: db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_update')?.value || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch channels', message: err.message });
  }
});

app.get('/api/filters', (req, res) => {
  try {
    res.json({
      sites: db.prepare('SELECT DISTINCT site FROM channels ORDER BY site').all().map(r => r.site),
      languages: db.prepare('SELECT DISTINCT lang FROM channels ORDER BY lang').all().map(r => r.lang),
      countries: db.prepare('SELECT DISTINCT country FROM channels ORDER BY country').all().map(r => r.country),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch filters', message: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const g = k => db.prepare('SELECT value FROM metadata WHERE key = ?').get(k)?.value || null;
    res.json({
      totalChannels: db.prepare('SELECT COUNT(*) as count FROM channels').get().count,
      lastUpdate: g('last_update'),
      filesProcessed: parseInt(g('files_processed') || 0),
      filesErrored: parseInt(g('files_errored') || 0),
      lastError: g('last_error') || '',
      hasGithubToken: !!GITHUB_TOKEN,
      refreshRunning: refreshState.running,
      refreshProgress: g('refresh_progress') || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats', message: err.message });
  }
});

// Refresh runs in the BACKGROUND — responds immediately so the proxy doesn't time out.
// The UI polls /api/stats to track progress.
app.post('/api/refresh', (req, res) => {
  if (refreshState.running) {
    return res.json({
      success: false,
      message: 'Refresh already in progress. Poll /api/stats for progress.',
      refreshRunning: true,
    });
  }

  // Respond immediately — job runs in background
  refreshState.running = true;
  refreshState.startedAt = new Date().toISOString();
  refreshState.error = null;
  refreshState.channelCount = null;

  res.json({
    success: true,
    message: 'Refresh started in background. Poll /api/stats for progress.',
    refreshRunning: true,
  });

  // Run async without awaiting — fire and forget
  fetchAndStoreChannels()
    .then(count => {
      refreshState.running = false;
      refreshState.finishedAt = new Date().toISOString();
      refreshState.channelCount = count;
      console.log(`Background refresh complete: ${count} channels`);
    })
    .catch(err => {
      refreshState.running = false;
      refreshState.error = err.message;
      console.error('Background refresh failed:', err.message);
      db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
        .run('last_error', err.message);
    });
});

app.post('/api/report', (req, res) => {
  try {
    const { channel_id, xmltv_id, channel_name, site, reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Reason required' });
    db.prepare('INSERT INTO reports (channel_id, xmltv_id, channel_name, site, reason) VALUES (?, ?, ?, ?, ?)').run(channel_id, xmltv_id, channel_name, site, reason.trim());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit report', message: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`EPG Browser on port ${PORT}`);
  console.log(GITHUB_TOKEN ? '✓ GitHub token present (5000 req/hr)' : '✗ No GITHUB_TOKEN — set in Coolify env vars');

  const count = db.prepare('SELECT COUNT(*) as count FROM channels').get().count;
  if (count === 0) {
    console.log('DB empty — running initial fetch in background...');
    refreshState.running = true;
    refreshState.startedAt = new Date().toISOString();
    fetchAndStoreChannels()
      .then(c => {
        refreshState.running = false;
        refreshState.channelCount = c;
        console.log('Ready!');
      })
      .catch(err => {
        refreshState.running = false;
        refreshState.error = err.message;
        console.error('Initial fetch failed:', err.message);
        db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run('last_error', err.message);
      });
  } else {
    console.log(`DB has ${count} channels — ready!`);
  }
});
