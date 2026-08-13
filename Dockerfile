# syntax=docker/dockerfile:1

# The image is the server: it serves the built client itself, so a deployment
# is one container behind one HTTPS domain, which is what Telegram wants.
#
# Node 24 for `node:sqlite` — the database is built into the runtime. The one
# thing that does have to be compiled is the engine: the rules and the bots are
# Rust, and they reach Node as a single addon.
#
# Debian rather than Alpine, and not by preference: a Node addon is a shared
# library, and the musl targets do not build one — `cannot produce cdylib for
# wc-napi as the target aarch64-unknown-linux-musl does not support these crate
# types`. Both stages have to agree on the libc, so both are glibc.

FROM rust:1-bookworm AS core
WORKDIR /core

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p wc-napi


FROM node:24-bookworm-slim AS build
WORKDIR /app

# Manifests first: this layer is what npm needs, and it only changes when a
# dependency does, so the install is cached across ordinary edits.
COPY package.json package-lock.json ./
COPY packages/core-native/package.json packages/core-native/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

# The addon, built in the stage above. It is copied rather than compiled here so
# the Node image never needs a Rust toolchain.
COPY --from=core /core/target/release/libwc_napi.so packages/core-native/wc-core.node

COPY tsconfig.base.json ./
COPY packages ./packages
# `npm run build` runs `scripts/no-lab-running.mjs` first — a workbench guard
# that refuses to rewrite `dist` while a tuning run is reading it. There is no
# lab in a container and it exits at once, but the file has to be here: the
# alternative is a build command that means one thing on a laptop and another
# on the host, which is how a client and a server come to disagree.
COPY scripts ./scripts
# The steps of `npm run build`, minus the one that would rebuild the addon this
# stage was just handed. `generate` writes the printed facts out of the addon
# into the TypeScript the client reads; `--check` in `typecheck` is what stops
# the two drifting.
RUN npm run generate \
 && npm run build -w @wc/shared \
 && npm run build -w @wc/server \
 && npm run build -w @wc/client \
 && npm prune --omit=dev


FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# Only what runs: the workspace symlinks under node_modules/@wc point at these
# directories, so each package keeps its manifest next to its dist.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core-native/package.json ./packages/core-native/
COPY --from=build /app/packages/core-native/index.cjs ./packages/core-native/
COPY --from=build /app/packages/core-native/wc-core.node ./packages/core-native/
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
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
