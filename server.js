// server.js
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
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
    logo_thumb TEXT DEFAULT '',
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
try { db.exec(`ALTER TABLE channels ADD COLUMN logo_thumb TEXT DEFAULT ''`); } catch (e) {}

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

// tvlogos serves small WebP thumbnails at /thumbs/... that exactly mirror
// the /countries/... structure findLogo() matches against (see
// generate-thumbnails.js / generate-manifest.js in that repo). So instead of
// building and maintaining a second parallel index just for thumbnails, we
// derive the thumb URL directly from whatever full-size URL was matched --
// same directory, .webp extension. If the thumbnail doesn't actually exist
// yet (e.g. tvlogos hasn't run its thumbnail generator since a logo was
// added), the front end falls back to the full-size image automatically.
function deriveThumbUrl(logoUrl) {
  if (!logoUrl) return '';
  return logoUrl
    .replace('/countries/', '/thumbs/')
    .replace(/\.(png|jpe?g|webp|svg|gif)$/i, '.webp');
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

// ── Getting the channel lists from GitHub ──────────────────────────────────
//
// We used to crawl the GitHub API + download ~650 files one by one from
// raw.githubusercontent.com. That hit the 60 requests/hour API limit, and the
// table was wiped *before* the crawl, so any failure left the site empty.
//
// Now: one shallow, sparse git clone of just sites/*/*.channels.xml (git
// transport is not subject to the API rate limit; ~5 s the first time, a tiny
// fetch afterwards), parse everything in memory, then replace the table in a
// single transaction. If anything fails, the previous data stays untouched.

const REPO_DIR = path.join(dataDir, 'epg-repo');
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function scrub(msg) {
  return GITHUB_TOKEN ? String(msg).split(GITHUB_TOKEN).join('***') : String(msg);
}

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 5 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('git is not installed in this container (add "git" to the Dockerfile).');
    throw new Error(`git ${args[0]} failed: ${scrub((err.stderr || err.message || '').toString().trim().split('\n').pop())}`);
  }
}

function repoUrl() {
  return GITHUB_TOKEN
    ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${EPG_REPO}.git`
    : `https://github.com/${EPG_REPO}.git`;
}

async function syncRepo() {
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
    await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', repoUrl(), REPO_DIR]);
    await git(['sparse-checkout', 'set', '--no-cone', '/sites/*/*.channels.xml'], REPO_DIR);
    await git(['checkout'], REPO_DIR);
  } else {
    await git(['remote', 'set-url', 'origin', repoUrl()], REPO_DIR);
    await git(['fetch', '--depth', '1', 'origin'], REPO_DIR);
    await git(['reset', '--hard', 'FETCH_HEAD'], REPO_DIR);
  }
  return git(['rev-parse', '--short', 'HEAD'], REPO_DIR);
}

function listChannelFiles() {
  const sitesDir = path.join(REPO_DIR, 'sites');
  const out = [];
  if (!fs.existsSync(sitesDir)) return out;
  for (const d of fs.readdirSync(sitesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(sitesDir, d.name))) {
      if (f.endsWith('.channels.xml')) out.push({ siteName: d.name, rel: `sites/${d.name}/${f}`, full: path.join(sitesDir, d.name, f) });
    }
  }
  return out;
}

async function fetchAndStoreChannels() {
  console.log('=== Starting channel fetch ===');
  const setMeta = db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');

  setMeta.run('refresh_progress', 'Syncing repo from GitHub...');
  const [commit, logoData] = await Promise.all([syncRepo(), fetchLogoManifest()]);
  const { logoMap, logosByCountry } = logoData;
  console.log(`Repo ${EPG_REPO} at ${commit}`);

  const channelFiles = listChannelFiles();
  console.log(`Found ${channelFiles.length} channel files`);
  if (channelFiles.length === 0) throw new Error('No channel files found in the repo checkout.');

  const parser = new xml2js.Parser();

  // Some sites ship more than one *.channels.xml (e.g. gigatv.3bbtv.co.th has
  // three snapshots in one directory), so the same channel can appear 2-3x.
  // Dedup on exact content rather than skipping files by name, because sites
  // like pluto.tv or dstv.com legitimately have many distinct per-country files.
  const seenChannels = new Set();
  const rows = [];
  let ok = 0, errors = 0, duplicates = 0;

  for (let i = 0; i < channelFiles.length; i++) {
    const file = channelFiles[i];
    try {
      const parsed = await parser.parseStringPromise(fs.readFileSync(file.full, 'utf8'));
      if (parsed.channels?.channel) {
        for (const ch of parsed.channels.channel) {
          const xmltvId = ch.$.xmltv_id || '';
          const name = ch._ || ch.$.xmltv_id || 'Unknown';
          const site = ch.$.site || file.siteName;
          const lang = ch.$.lang || 'en';
          const siteId = ch.$.site_id || '';

          const dedupKey = `${site}\u0000${siteId}\u0000${xmltvId}\u0000${lang}\u0000${name}`;
          if (seenChannels.has(dedupKey)) { duplicates++; continue; }
          seenChannels.add(dedupKey);

          const { country, cc } = detectCountry(xmltvId, file.siteName);
          const logo = findLogo(logoMap, logosByCountry, name, xmltvId, cc, country);
          rows.push([site, lang, xmltvId, siteId, name, country, logo, deriveThumbUrl(logo)]);
        }
        ok++;
      }
    } catch (err) {
      errors++;
      console.error(`Error on ${file.rel}: ${err.message}`);
    }
    if (i % 25 === 0) setMeta.run('refresh_progress', `Parsing ${i}/${channelFiles.length} files, ${rows.length} channels`);
  }

  if (rows.length === 0) throw new Error('Parsed 0 channels -- keeping the existing data.');

  // Replace the table contents atomically: readers see either the old data or the new.
  const insert = db.prepare(
    `INSERT INTO channels (site, lang, xmltv_id, site_id, name, country, logo, logo_thumb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    db.exec('DELETE FROM channels');
    for (const r of rows) insert.run(...r);
  })();

  setMeta.run('last_update', new Date().toISOString());
  setMeta.run('repo_commit', commit);
  setMeta.run('files_processed', ok.toString());
  setMeta.run('files_errored', errors.toString());
  setMeta.run('last_error', '');
  setMeta.run('refresh_progress', 'complete');
  console.log(`=== Done: ${rows.length} channels from ${ok}/${channelFiles.length} files (${errors} errors, ${duplicates} exact duplicates skipped) ===`);
  return rows.length;
}

// Single entry point for every refresh (manual button, startup, daily timer).
function startRefresh() {
  if (refreshState.running) return false;
  refreshState.running = true;
  refreshState.startedAt = new Date().toISOString();
  refreshState.finishedAt = null;
  refreshState.error = null;
  refreshState.channelCount = null;
  fetchAndStoreChannels()
    .then(count => {
      refreshState.running = false;
      refreshState.finishedAt = new Date().toISOString();
      refreshState.channelCount = count;
      console.log(`Refresh complete: ${count} channels`);
    })
    .catch(err => {
      const msg = scrub(err.message);
      refreshState.running = false;
      refreshState.finishedAt = new Date().toISOString();
      refreshState.error = msg;
      console.error('Refresh failed:', msg);
      db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run('last_error', msg);
      db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run('refresh_progress', 'failed');
    });
  return true;
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
      repoCommit: g('repo_commit'),
      hasGithubToken: !!GITHUB_TOKEN,
      refreshRunning: refreshState.running,
      refreshProgress: g('refresh_progress') || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats', message: err.message });
  }
});

// Refresh runs in the BACKGROUND -- responds immediately so the proxy doesn't time out.
// The UI polls /api/stats to track progress.
app.post('/api/refresh', (req, res) => {
  const started = startRefresh();
  res.json({
    success: started,
    message: started ? 'Refresh started in background. Poll /api/stats for progress.' : 'Refresh already in progress. Poll /api/stats for progress.',
    refreshRunning: true,
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

app.listen(PORT, () => {
  console.log(`EPG Browser on port ${PORT}`);
  if (GITHUB_TOKEN) console.log('GitHub token present (used for git clone auth only)');

  const count = db.prepare('SELECT COUNT(*) as count FROM channels').get().count;
  const last = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_update')?.value;
  const stale = !last || (Date.now() - new Date(last).getTime()) > REFRESH_INTERVAL_MS;

  if (count === 0 || stale) {
    console.log(count === 0 ? 'DB empty -- running initial fetch in background...' : 'Data older than 24h -- refreshing in background...');
    startRefresh();
  } else {
    console.log(`DB has ${count} channels (updated ${last}) -- ready!`);
  }
  setInterval(startRefresh, REFRESH_INTERVAL_MS);
});
