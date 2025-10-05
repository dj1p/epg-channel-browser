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

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure data directory exists
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const dbPath = path.join(dataDir, 'epg-channels.db');
const db = new Database(dbPath);
console.log(`Database location: ${dbPath}`);

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site TEXT NOT NULL,
    lang TEXT NOT NULL,
    xmltv_id TEXT NOT NULL,
    site_id TEXT,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
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

// Country mapping for common channel patterns
const countryMapping = {
  '.us': 'United States',
  '.uk': 'United Kingdom',
  '.ca': 'Canada',
  '.au': 'Australia',
  '.de': 'Germany',
  '.fr': 'France',
  '.es': 'Spain',
  '.it': 'Italy',
  '.nl': 'Netherlands',
  '.br': 'Brazil',
  '.mx': 'Mexico',
  '.ar': 'Argentina',
  '.in': 'India',
  '.jp': 'Japan',
  '.kr': 'South Korea',
  '.cn': 'China',
  '.ru': 'Russia',
  '.se': 'Sweden',
  '.no': 'Norway',
  '.dk': 'Denmark',
  '.fi': 'Finland',
  '.pl': 'Poland',
  '.tr': 'Turkey',
  '.za': 'South Africa',
  '.nz': 'New Zealand',
  '.ie': 'Ireland',
  '.pt': 'Portugal',
  '.gr': 'Greece',
  '.ch': 'Switzerland',
  '.at': 'Austria',
  '.be': 'Belgium',
  '.cz': 'Czech Republic',
  '.ro': 'Romania',
  '.hu': 'Hungary',
  '.il': 'Israel',
  '.ae': 'United Arab Emirates',
  '.sg': 'Singapore',
  '.th': 'Thailand',
  '.my': 'Malaysia',
  '.id': 'Indonesia',
  '.ph': 'Philippines',
  '.vn': 'Vietnam',
};

// Detect country from xmltv_id
function detectCountry(xmltvId, siteName) {
  for (const [suffix, country] of Object.entries(countryMapping)) {
    if (xmltvId.toLowerCase().includes(suffix)) {
      return country;
    }
  }
  
  for (const [suffix, country] of Object.entries(countryMapping)) {
    if (siteName.includes(suffix.substring(1))) {
      return country;
    }
  }
  
  return 'International';
}

async function fetchAndStoreChannels() {
  console.log('Fetching channel data from GitHub...');
  
  try {
    const treeResponse = await axios.get(
      'https://api.github.com/repos/dj1p/epg/git/trees/master?recursive=1',
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'EPG-Browser'
        }
      }
    );

    const channelFiles = treeResponse.data.tree.filter(file => 
      file.path.startsWith('sites/') && 
      file.path.endsWith('.channels.xml') &&
      file.type === 'blob'
    );

    console.log(`Found ${channelFiles.length} channel files`);

    // Clear existing channels
    db.exec('DELETE FROM channels');
    
    const parser = new xml2js.Parser();
    const insertStmt = db.prepare(`
      INSERT INTO channels (site, lang, xmltv_id, site_id, name, country)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let totalChannels = 0;
    const batchSize = 5;

    for (let i = 0; i < channelFiles.length; i += batchSize) {
      const batch = channelFiles.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (file) => {
        try {
          const rawUrl = `https://raw.githubusercontent.com/dj1p/epg/master/${file.path}`;
          const xmlResponse = await axios.get(rawUrl, {
            headers: { 'User-Agent': 'EPG-Browser' }
          });

          const result = await parser.parseStringPromise(xmlResponse.data);
          
          if (result.channels && result.channels.channel) {
            const siteName = file.path.split('/')[1];
            
            const insertMany = db.transaction((channels) => {
              for (const channel of channels) {
                const xmltvId = channel.$.xmltv_id || '';
                insertStmt.run(
                  channel.$.site || siteName,
                  channel.$.lang || 'en',
                  xmltvId,
                  channel.$.site_id || '',
                  channel._ || channel.$.xmltv_id || 'Unknown',
                  detectCountry(xmltvId, siteName)
                );
                totalChannels++;
              }
            });

            insertMany(result.channels.channel);
          }
        } catch (error) {
          console.error(`Error processing ${file.path}:`, error.message);
        }
      }));

      console.log(`Progress: ${Math.min(i + batchSize, channelFiles.length)}/${channelFiles.length} files processed (${totalChannels} channels)`);

      if (i + batchSize < channelFiles.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Update metadata
    db.prepare('INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run('last_update', new Date().toISOString());

    console.log(`Successfully stored ${totalChannels} channels in database`);
    return totalChannels;

  } catch (error) {
    console.error('Error fetching channels:', error.message);
    throw error;
  }
}

// API endpoint to get channels with pagination and filtering
app.get('/api/channels', (req, res) => {
  try {
    const { search, site, lang, page = 1, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM channels WHERE 1=1';
    const params = [];

    if (search) {
      query += ' AND (name LIKE ? OR country LIKE ? OR xmltv_id LIKE ?)';
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
    }

    if (site) {
      query += ' AND site = ?';
      params.push(site);
    }

    if (lang) {
      query += ' AND lang = ?';
      params.push(lang);
    }

    // Get total count
    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
    const countResult = db.prepare(countQuery).get(...params);
    const totalCount = countResult.count;

    // Add pagination
    const offset = (page - 1) * limit;
    query += ' ORDER BY name LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const channels = db.prepare(query).all(...params);

    // Get metadata
    const lastUpdate = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_update');

    res.json({
      channels,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / limit)
      },
      lastUpdate: lastUpdate?.value || null
    });

  } catch (error) {
    console.error('Error in /api/channels:', error);
    res.status(500).json({ 
      error: 'Failed to fetch channels',
      message: error.message 
    });
  }
});

// API endpoint to get filters (sites, languages, countries)
app.get('/api/filters', (req, res) => {
  try {
    const sites = db.prepare('SELECT DISTINCT site FROM channels ORDER BY site').all();
    const languages = db.prepare('SELECT DISTINCT lang FROM channels ORDER BY lang').all();
    const countries = db.prepare('SELECT DISTINCT country FROM channels ORDER BY country').all();

    res.json({
      sites: sites.map(s => s.site),
      languages: languages.map(l => l.lang),
      countries: countries.map(c => c.country)
    });
  } catch (error) {
    console.error('Error in /api/filters:', error);
    res.status(500).json({ 
      error: 'Failed to fetch filters',
      message: error.message 
    });
  }
});

// API endpoint to get database stats
app.get('/api/stats', (req, res) => {
  try {
    const totalChannels = db.prepare('SELECT COUNT(*) as count FROM channels').get();
    const lastUpdate = db.prepare('SELECT value FROM metadata WHERE key = ?').get('last_update');

    res.json({
      totalChannels: totalChannels.count,
      lastUpdate: lastUpdate?.value || null
    });
  } catch (error) {
    console.error('Error in /api/stats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch stats',
      message: error.message 
    });
  }
});

// API endpoint to force refresh
app.post('/api/refresh', async (req, res) => {
  try {
    const channelCount = await fetchAndStoreChannels();

    res.json({
      success: true,
      channelCount,
      lastUpdate: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to refresh channels',
      message: error.message 
    });
  }
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize server
app.listen(PORT, async () => {
  console.log(`EPG Browser server running on port ${PORT}`);
  console.log(`Visit: http://localhost:${PORT}`);
  
  // Check if database needs initialization
  const channelCount = db.prepare('SELECT COUNT(*) as count FROM channels').get();
  
  if (channelCount.count === 0) {
    console.log('Database is empty. Fetching channels from GitHub...');
    try {
      await fetchAndStoreChannels();
      console.log('Server ready!');
    } catch (error) {
      console.error('Failed to initialize database:', error.message);
      console.log('Server started but database is empty. Use POST /api/refresh to populate.');
    }
  } else {
    console.log(`Database contains ${channelCount.count} channels`);
    console.log('Server ready!');
  }
});
