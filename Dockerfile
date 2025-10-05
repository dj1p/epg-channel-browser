FROM node:18-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY server.js ./
COPY public ./public

# Create directory for database
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Set environment variable
ENV NODE_ENV=production

# Volume for persistent database
VOLUME ["/app/data"]

# Start the application
CMD ["node", "server.js"]
