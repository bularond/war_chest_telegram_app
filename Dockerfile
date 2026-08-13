# syntax=docker/dockerfile:1

# The image is the server: it serves the built client itself, so a deployment
# is one container behind one HTTPS domain, which is what Telegram wants.
#
# Node 24 for `node:sqlite` — the database is built into the runtime, so there
# is no native module to compile and no toolchain in the final image.

FROM node:24-alpine AS build
WORKDIR /app

# Manifests first: this layer is what npm needs, and it only changes when a
# dependency does, so the install is cached across ordinary edits.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/bots/package.json packages/bots/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/tooling/package.json packages/tooling/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
# `npm run build` runs `scripts/no-lab-running.mjs` first — a workbench guard
# that refuses to rewrite `dist` while a tuning run is reading it. There is no
# lab in a container and it exits at once, but the file has to be here: the
# alternative is a build command that means one thing on a laptop and another
# on the host, which is how a client and a server come to disagree.
COPY scripts ./scripts
# shared → bots → server → client. The bots are not optional: the server's
# worker imports them, and a missing build only shows up on the bot's turn.
RUN npm run build && npm prune --omit=dev


FROM node:24-alpine AS runtime
WORKDIR /app

# Only what runs: the workspace symlinks under node_modules/@wc point at these
# directories, so each package keeps its manifest next to its dist.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/bots/package.json ./packages/bots/
COPY --from=build /app/packages/bots/dist ./packages/bots/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/client/dist ./packages/client/dist

# Profiles and finished games. Lobbies and games in progress are in memory, so
# this is the only thing a restart has to survive.
RUN mkdir -p /data && chown -R node:node /data
ENV DB_PATH=/data/war-chest.db
VOLUME /data

USER node
EXPOSE 8787
CMD ["node", "packages/server/dist/index.js"]
