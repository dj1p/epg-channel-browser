# EPG Channel Browser

A searchable web application to browse and copy EPG (Electronic Program Guide) channel sources from the [dj1p/epg](https://github.com/dj1p/epg) repository.

## Features

- 🔍 **Search** - Search by channel name, country, or XMLTV ID
- 🌐 **Filter by Site** - Filter channels by EPG source
- 🗣️ **Filter by Language** - Filter channels by language code
- 📋 **One-Click Copy** - Copy XML lines directly to clipboard
- 🔄 **Auto-Refresh** - Data cached for 24 hours with manual refresh option
- 🎨 **Modern UI** - Responsive design with animated gradient background
- 🚀 **Fast** - Efficient caching and batch processing

## Project Structure

```
epg-channel-browser/
├── server.js           # Node.js backend server
├── package.json        # Dependencies
├── Dockerfile         # Docker configuration
├── public/
│   ├── index.html     # Frontend HTML
│   └── app.js         # Frontend JavaScript
└── README.md          # This file
```

## Installation

### Option 1: Local Development

1. **Clone or create the project directory:**
```bash
mkdir epg-channel-browser
cd epg-channel-browser
```

2. **Create the required files:**
   - Copy `server.js` to the root directory
   - Copy `package.json` to the root directory
   - Create a `public` folder
   - Copy `index.html` and `app.js` to the `public` folder

3. **Install dependencies:**
```bash
npm install
```

4. **Start the server:**
```bash
npm start
```

5. **Open your browser:**
```
http://localhost:3000
```

### Option 2: Deploy to Coolify

1. **Create a new Git repository with all the files**

2. **In Coolify:**
   - Create a new Application
   - Connect your Git repository
   - Select "Dockerfile" as build pack
   - Set port to `3000`
   - Deploy!

### Option 3: Docker

1. **Build the Docker image:**
```bash
docker build -t epg-browser .
```

2. **Run the container:**
```bash
docker run -p 3000:3000 epg-browser
```

3. **Access the application:**
```
http://localhost:3000
```

## API Endpoints

### GET `/api/channels`
Fetches all channels from the GitHub repository. Returns cached data if less than 24 hours old.

**Response:**
```json
{
  "channels": [
    {
      "site": "tvtv.us",
      "lang": "en",
      "xmltv_id": "CNN.us",
      "site_id": "10142",
      "name": "CNN",
      "country": "United States"
    }
  ],
  "cached": true,
  "lastUpdate": "2025-10-02T12:00:00.000Z"
}
```

### POST `/api/refresh`
Forces a refresh of channel data from GitHub.

**Response:**
```json
{
  "success": true,
  "channelCount": 1543,
  "lastUpdate": "2025-10-02T12:30:00.000Z"
}
```

## Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (default: production in Docker)

## How It Works

1. **Data Fetching**: The backend fetches the repository tree from GitHub API
2. **XML Parsing**: All `.channels.xml` files in the `/sites` directory are downloaded and parsed
3. **Country Detection**: Automatically detects country from XMLTV IDs (e.g., `.us`, `.uk`, `.fr`)
4. **Caching**: Results are cached for 24 hours to reduce API calls
5. **Filtering**: Frontend provides real-time search and filtering

## Usage Example

Once you find the channel you want:

1. Click "Copy XML" button
2. Paste into your channels XML file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<channels>
  <channel site="tvtv.us" lang="en" xmltv_id="CNN.us" site_id="10142">CNN</channel>
  <channel site="arirang.com" lang="en" xmltv_id="ArirangTV.kr" site_id="CH_K">Arirang TV</channel>
</channels>
```

3. Use with the EPG grabber:
```bash
npm run grab --- --channels=path/to/custom.channels.xml
```

## Performance Notes

- Initial load fetches all channels (may take 1-2 minutes on first run)
- Data is cached for 24 hours
- Batch processing with delays to avoid GitHub rate limits
- Supports thousands of channels efficiently

## Troubleshooting

### "Failed to fetch channels" error
- Check your internet connection
- GitHub API rate limits may apply (60 requests/hour unauthenticated)
- Try refreshing after a few minutes

### Slow initial load
- First load parses all XML files from the repository
- Subsequent loads use cached data (much faster)
- Consider setting up the refresh to run during off-peak hours

### Port already in use
- Change the port: `PORT=3001 npm start`
- Or kill the process using port 3000

## Development

Run with auto-reload during development:

```bash
npm run dev
```

## Contributing

Feel free to submit issues or pull requests to improve the application!

## Credits

- EPG data from [dj1p/epg](https://github.com/dj1p/epg)
- Based on [iptv-org/epg](https://github.com/iptv-org/epg) project

## License

MIT