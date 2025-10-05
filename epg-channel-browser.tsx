// server.js
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cache for channel data
let channelsCache = [];
let lastFetchTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

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
  
  // Try to detect from site name
  for (const [suffix, country] of Object.entries(countryMapping)) {
    if (siteName.includes(suffix.substring(1))) {
      return country;
    }
  }
  
  return 'International';
}

async function fetchChannelsFromGitHub() {
  console.log('Fetching channel data from GitHub...');
  
  try {
    // Get the repository tree
    const treeResponse = await axios.get(
      'https://api.github.com/repos/dj1p/epg/git/trees/master?recursive=1',
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'EPG-Browser'
        }
      }
    );

    // Filter for .channels.xml files in the sites directory
    const channelFiles = treeResponse.data.tree.filter(file => 
      file.path.startsWith('sites/') && 
      file.path.endsWith('.channels.xml') &&
      file.type === 'blob'
    );

    console.log(`Found ${channelFiles.length} channel files`);

    const allChannels = [];
    const parser = new xml2js.Parser();

    // Process files in batches to avoid rate limiting
    const batchSize = 5;
    for (let i = 0; i < channelFiles.length; i += batchSize) {
      const batch = channelFiles.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (file) => {
        try {
          // Fetch raw XML content
          const rawUrl = `https://raw.githubusercontent.com/dj1p/epg/master/${file.path}`;
          const xmlResponse = await axios.get(rawUrl, {
            headers: { 'User-Agent': 'EPG-Browser' }
          });

          // Parse XML
          const result = await parser.parseStringPromise(xmlResponse.data);
          
          if (result.channels && result.channels.channel) {
            const siteName = file.path.split('/')[1];
            
            result.channels.channel.forEach(channel => {
              const xmltvId = channel.$.xmltv_id || '';
              allChannels.push({
                site: channel.$.site || siteName,
                lang: channel.$.lang || 'en',
                xmltv_id: xmltvId,
                site_id: channel.$.site_id || '',
                name: channel._ || channel.$.xmltv_id || 'Unknown',
                country: detectCountry(xmltvId, siteName)
              });
            });
          }
        } catch (error) {
          console.error(`Error processing ${file.path}:`, error.message);
        }
      }));

      // Small delay between batches
      if (i + batchSize < channelFiles.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`Successfully loaded ${allChannels.length} channels`);
    return allChannels;

  } catch (error) {
    console.error('Error fetching channels:', error.message);
    throw error;
  }
}

// API endpoint to get all channels
app.get('/api/channels', async (req, res) => {
  try {
    // Check if cache is valid
    if (channelsCache.length > 0 && lastFetchTime && 
        (Date.now() - lastFetchTime) < CACHE_DURATION) {
      return res.json({
        channels: channelsCache,
        cached: true,
        lastUpdate: new Date(lastFetchTime).toISOString()
      });
    }

    // Fetch fresh data
    channelsCache = await fetchChannelsFromGitHub();
    lastFetchTime = Date.now();

    res.json({
      channels: channelsCache,
      cached: false,
      lastUpdate: new Date(lastFetchTime).toISOString()
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to fetch channels',
      message: error.message 
    });
  }
});

// API endpoint to force refresh
app.post('/api/refresh', async (req, res) => {
  try {
    channelsCache = await fetchChannelsFromGitHub();
    lastFetchTime = Date.now();

    res.json({
      success: true,
      channelCount: channelsCache.length,
      lastUpdate: new Date(lastFetchTime).toISOString()
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
  
  // Pre-load channels on startup
  try {
    console.log('Pre-loading channel data...');
    channelsCache = await fetchChannelsFromGitHub();
    lastFetchTime = Date.now();
    console.log('Server ready!');
  } catch (error) {
    console.error('Failed to pre-load channels:', error.message);
    console.log('Server will load channels on first request.');
  }
});