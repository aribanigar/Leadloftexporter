FROM node:20-alpine

WORKDIR /app

# Baileys pulls in native crypto bindings — pin the toolchain so npm install
# never tries to compile against a missing g++ on Alpine.
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

# Render maps a persistent disk to /app/.baileys_auth so paired sessions
# survive container restarts; /app/data is persisted by the same disk.
RUN mkdir -p /app/.baileys_auth /app/data

ENV NODE_ENV=production
EXPOSE 8001
CMD ["node", "server.js"]
