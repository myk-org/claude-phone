FROM node:20-slim

WORKDIR /app

# Install curl for the Claude Code installer
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI as node user so it's available at runtime
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:${PATH}"
USER root

# Install dependencies first (better caching)
COPY claude-api-server/package*.json ./
RUN npm install --production

# Copy application code
COPY claude-api-server/ .

# Install claude-phone CLI
COPY cli/ /cli/
WORKDIR /cli
RUN npm install --production
RUN npm link
WORKDIR /app

# HTTP API port
EXPOSE 3333

USER node

CMD ["node", "server.js"]
