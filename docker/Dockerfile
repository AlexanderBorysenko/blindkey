# syntax=docker/dockerfile:1

# ---- build: compile TypeScript and the native modules -----------------------
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 and argon2 have no musl prebuilds; compile them here.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/cli packages/cli
RUN npm run build
# Drop devDependencies; keeps the compiled native modules and the workspace links.
RUN npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    BLINDKEY_DATA_DIR=/data \
    BLINDKEY_PORT=8080
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/scripts ./packages/server/scripts
COPY --from=build /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs
COPY docker/backup-loop.sh ./docker/backup-loop.sh
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "docker/healthcheck.mjs"]
ENTRYPOINT ["node", "packages/server/dist/cli.js"]
CMD ["start"]
