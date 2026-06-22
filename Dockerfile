# Image for the search typeahead Node service.
FROM node:20-slim

WORKDIR /app

# Build tools so better-sqlite3 can compile if no prebuilt binary is available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the source.
COPY . .

EXPOSE 3000

# Seed the dataset, then start the server.
# REDIS_URL is provided by docker-compose so the cache uses the Redis service.
CMD ["sh", "-c", "npm run load && npm start"]
