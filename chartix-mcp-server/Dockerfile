# Multi-stage so the shipped image carries no compiler and no dev dependencies.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Loopback by default. This process holds a Chartix credential and Chartix does
# not gate intraday data server-side, so exposing it is a decision, not a
# default — see README "Hosting".
ENV HOST=127.0.0.1
ENV PORT=8420
EXPOSE 8420

# Unprivileged: the node image ships a `node` user.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8420)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
