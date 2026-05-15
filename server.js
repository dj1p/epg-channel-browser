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

// Your two repos
const EPG_REPO = 'dj1p/epg';
const TVLOGOS_RAW_BASE = 'https://raw.githubusercontent.com/dj1p/tvlogos/main';

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

// Migration: add logo column if missing
try { db.exec(`ALTER TABLE channels ADD COLUMN logo TEXT DEFAULT ''`); } catch (e) {}

// Country mapping
const countryMapping = {
  '.us': 'United States', '.uk': 'United Kingdom', '.ca': 'Canada',
  '.au': 'Australia', '.de': 'Germany', '.fr': 'France', '.es': 'Spain',
  '.it': 'Italy', '.nl': 'Netherlands', '.br': 'Brazil', '.mx': 'Mexico',
  '.ar': 'Argentina', '.in': 'India', '.jp': 'Japan', '.kr': 'South Korea',
  '.cn': 'China', '.ru': 'Russia', '.se': 'Sweden', '.no': 'Norway',
  '.dk': 'Denmark', '.fi': 'Finland', '.pl': 'Poland', '.tr': 'Turkey',
  '.za': 'South Africa', '.nz': 'New Zealand', '.ie': 'Ireland',
  '.pt': 'Portugal', '.gr': 'Greece', '.ch': 'Switzerland', '.at': 'Austria',
  '.be': 'Belgium', '.cz': 'Czech Republic', '.ro': 'Romania', '.hu': 'Hungary',
  '.il': 'Israel', '.ae': 'United Arab Emirates', '.sg': 'Singapore',
  '.th': 'Thailand', '.my': 'Malaysia', '.id': 'Indonesia', '.ph': 'Philippines',
  '.vn': 'Vietnam',
};

function detectCountry(xmltvId, siteName) {
  for (const [suffix, country] of Object.entries(countryMapping)) {
    if (xmltvId.toLowerCase().endsWith(suffix)) return country;
  }
  for (const [suffix, country] of Object.entries(countryMapping)) {
    if (xmltvId.toLowerCase().includes(suffix)) return country;
  }
  for (const [suffix, country] of Object.entries(countryMapping)) {
    if (siteName.includes(suffix.substring(1))) return country;
  }
  return 'International';
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

/**
 * Fetch logos-manifest.json from dj1p/tvlogos.
 * The manifest is an array of objects: { name, path, download_url, ... }
 * or possibly just an array of path strings.
 * We build a map: lowercase-stem -> raw URL
 * e.g. "bbc-one-uk" -> "https://raw.githubusercontent.com/dj1p/tvlogos/main/countries/united-kingdom/bbc-one-uk.png"
 */
async function fetchLogoManifest() {
  console.log('Fetching logos-manifest.json from dj1p/tvlogos...');
  try {
    const resp = await axios.get(`${TVLOGOS_RAW_BASE}/logos-manifest.json`, {
      timeout: 30000,
      headers: { 'User-Agent': 'EPG-Browser/2.0' }
    });
    const manifest = resp.data;
    const logoMap = {};

    // Handle both array-of-objects and array-of-strings
    const entries = Array.isArray(manifest) ? manifest : Object.values(manifest).flat();

    for (const entry of entries) {
      let filePath = '';
      if (typeof entry === 'string') {
        filePath = entry;
      } else if (entry && typeof entry === 'object') {
        // prefer the path field, fall back to name/url
        filePath = entry.path || entry.name || '';
      }
      if (!filePath || !filePath.toLowerCase().endsWith('.png')) continue;

      const fileName = filePath.split('/').pop();
      const stem = fileName.replace(/\.png$/i, '').toLowerCase();
      // Always build URL from the path in the manifest
      const normPath = filePath.replace(/^\//, '');
      logoMap[stem] = `${TVLOGOS_RAW_BASE}/${normPath}`;
    }

    console.log(`Logo manifest loaded: ${Object.keys(logoMap).length} logos`);
    return logoMap;
  } catch (err) {
    console.warn('Could not fetch logo manifest:', err.message);
    return {};
  }
}

/**
 * Match a channel to a logo using the tvlogos naming convention:
 * Filenames are lowercase, spaces replaced with dashes, & replaced with and,
 * country code appended at end: e.g. "bbc-one-uk.png", "cnn-us.png"
 */
function findLogo(logoMap, channelName, xmltvId) {
  if (!logoMap || Object.keys(logoMap).length === 0) return '';

  function toSlug(str) {
    return str
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Extract country code from end of xmltv_id e.g. "CNN.us" -> "us"
  const ccMatch = xmltvId.match(/\.([a-z]{2,3})$/i);
  const cc = ccMatch ? ccMatch[1].toLowerCase() : null;

  // xmltv_id without the country suffix
  const xmltvBase = xmltvId.replace(/\.[a-z]{2,3}$/i, '');

  const nameSlug = toSlug(channelName);
  const xmltvSlug = toSlug(xmltvBase);

  const candidates = [];

  // 1. Full xmltv_id as slug (e.g. "bbc-one-uk" from "BBCOne.uk")
  candidates.push(toSlug(xmltvId));

  if (cc) {
    // 2. name-cc  (e.g. "cnn-us")
    candidates.push(`${nameSlug}-${cc}`);
    // 3. xmltvBase-cc
    if (xmltvSlug !== nameSlug) candidates.push(`${xmltvSlug}-${cc}`);
  }

  // 4. name only
  candidates.push(nameSlug);
  // 5. xmltv base only
  if (xmltvSlug !== nameSlug) candidates.push(xmltvSlug);

  for (const c of candidates) {
    if (logoMap[c]) return logoMap[c];
  }

  // 6. Prefix match: logoMap key starts with nameSlug + "-"
  const prefix = nameSlug + '-';
  const hit = Object.keys(logoMap).find(k => k.startsWith(prefix));
  if (hit) return logoMap[hit];

  return '';
}

async function fetchAndStoreChannels() {
  console.log('=== Starting channel fetch ===');
  if (!GITHUB_TOKEN) {
    console.warn('No GITHUB_TOKEN — unauthenticated API allows only 60 req/hour.');
    console.warn('Set GITHUB_TOKEN env var in Coolify for reliable full fetching (5000 req/hour).');
  }

  const [epgBranch, logoMap] = await Promise.all([
    detectBranch(EPG_REPO),
    fetchLogoManifest(),
  ]);
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

  if (treeResp.data.truncated) console.warn('GitHub tree response truncated — repo may be very large.');

  const channelFiles = treeResp.data.tree.filter(f =>
    f.path.startsWith('sites/') && f.path.endsWith('.channels.xml') && f.type === 'blob'
  );

  console.log(`Found ${channelFiles.length} channel files`);
  if (channelFiles.length === 0) throw new Error('No channel files found — repo structure may have changed.');

  const remaining = treeResp.headers?.['x-ratelimit-remaining'];
  console.log(`Rate limit remaining: ${remaining}/${treeResp.headers?.['x-ratelimit-limit']}`);
  if (remaining && parseInt(remaining) < channelFiles.length) {
    console.warn(`Only ${remaining} requests left but need ~${channelFiles.length}. Some files may be skipped!`);
  }

  db.exec('DELETE FROM channels');

  const parser = new xml2js.Parser();
  const insert = db.prepare(
    `INSERT INTO channels (site, lang, xmltv_id, site_id, name, country, logo) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let total = 0, ok = 0, errors = 0;
  const batchSize = GITHUB_TOKEN ? 10 : 3;

  for (let i = 0; i < channelFiles.length; i += batchSize) {
    const batch = channelFiles.slice(i, i + batchSize);

    await Promise.all(batch.map(async (file) => {
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
              const country = detectCountry(xmltvId, siteName);
              const logo = findLogo(logoMap, name, xmltvId);
              insert.run(ch.$.site || siteName, ch.$.lang || 'en', xmltvId, ch.$.site_id || '', name, country, logo);
              total++;
            }
          })(parsed.channels.channel);
          ok++;
        }
      } catch (err) {
        errors++;
        if ([403, 429].includes(err.response?.status)) {
          console.error(`Rate limited on ${file.path} — add GITHUB_TOKEN`);
        } else {
          console.error(`Error on ${file.path}: ${err.message}`);
        }
      }
    }));

    if (i % (batchSize * 10) === 0) {
      console.log(`Progress: ${Math.min(i + batchSize, channelFiles.length)}/${channelFiles.length} | ${total} channels | ${errors} errors`);
    }

    if (i + batchSize < channelFiles.length) {
      await new Promise(r => setTimeout(r, GITHUB_TOKEN ? 300 : 2000));
    }
  }

  const meta = db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
  meta.run('last_update', new Date().toISOString());
  meta.run('files_processed', ok.toString());
  meta.run('files_errored', errors.toString());
  meta.run('last_error', '');

  console.log(`=== Done: ${total} channels from ${ok}/${channelFiles.length} files (${errors} errors) ===`);
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

    const channels = db.prepare(q).all(...p);
    const lastUpdate = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_update');

    res.json({
      channels,
      pagination: { page: parseInt(page), limit: parseInt(limit), totalCount, totalPages: Math.ceil(totalCount / parseInt(limit)) },
      lastUpdate: lastUpdate?.value || null,
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
    const g = (k) => db.prepare('SELECT value FROM metadata WHERE key = ?').get(k)?.value || null;
    res.json({
      totalChannels: db.prepare('SELECT COUNT(*) as count FROM channels').get().count,
      lastUpdate: g('last_update'),
      filesProcessed: parseInt(g('files_processed') || 0),
      filesErrored: parseInt(g('files_errored') || 0),
      lastError: g('last_error') || '',
      hasGithubToken: !!GITHUB_TOKEN,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats', message: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const count = await fetchAndStoreChannels();
    res.json({ success: true, channelCount: count, lastUpdate: new Date().toISOString() });
  } catch (err) {
    console.error('Refresh failed:', err.message);
    db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run('last_error', err.message);
    res.status(500).json({ error: 'Failed to refresh', message: err.message });
  }
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

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`EPG Browser on port ${PORT}`);
  console.log(GITHUB_TOKEN ? '✓ GitHub token present (5000 req/hr)' : '✗ No GITHUB_TOKEN (60 req/hr) — set in Coolify!');

  const count = db.prepare('SELECT COUNT(*) as count FROM channels').get().count;
  if (count === 0) {
    console.log('DB empty — running initial fetch...');
    try {
      await fetchAndStoreChannels();
      console.log('Ready!');
    } catch (err) {
      console.error('Initial fetch failed:', err.message);
      db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run('last_error', err.message);
    }
  } else {
    console.log(`DB has ${count} channels — ready!`);
  }
});
