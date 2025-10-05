#!/bin/bash

# EPG Channel Browser Setup Script

echo "🚀 Setting up EPG Channel Browser..."

# Create project directory
mkdir -p epg-channel-browser
cd epg-channel-browser

# Create public directory
mkdir -p public

echo "📁 Created project structure"

# Download files from artifacts (you'll need to paste these manually)
echo ""
echo "📝 Next steps:"
echo "1. Copy server.js to this directory"
echo "2. Copy package.json to this directory"
echo "3. Copy index.html to ./public/"
echo "4. Copy app.js to ./public/"
echo "5. Copy Dockerfile to this directory (optional, for Docker)"
echo ""
echo "Then run:"
echo "  npm install"
echo "  npm start"
echo ""
echo "Or with Docker:"
echo "  docker build -t epg-browser ."
echo "  docker run -p 3000:3000 epg-browser"

echo ""
echo "✅ Setup script complete!"