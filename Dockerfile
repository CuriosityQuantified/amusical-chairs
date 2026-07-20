# Works on any container host (Fly.io, Cloud Run, DigitalOcean, self-hosted).
# Constraint: run exactly ONE instance — rooms live in process memory.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY public ./public
EXPOSE 3000
CMD ["node", "server/index.js"]
