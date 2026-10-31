# Build context = apps/reserves (self-contained; it is not an npm workspace).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.node.json ./
COPY src ./src
RUN npx tsc -p tsconfig.node.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tip20-registry.json ./tip20-registry.json
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8790 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 8790
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8790/livez >/dev/null || exit 1
CMD ["node", "dist/server.js"]
