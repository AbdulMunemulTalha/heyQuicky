# Stage 1: build the React dashboard.
FROM node:22-alpine AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client ./client
RUN npm run build

# Stage 2: the server, with only runtime dependencies.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY --from=client /app/client/dist ./client/dist
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
