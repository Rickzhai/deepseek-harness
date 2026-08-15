# Multi-user DeepSeek Harness gateway image.
#
# Builds the whole dsh checkout (host library + Web frontend dist) so each
# per-user `dsh web` child can serve the GUI, then runs `dsh-web-gateway` as
# the entrypoint. The gateway authenticates users and spawns one `dsh web`
# child per user, all inside this container; data persists in /data.

FROM node:22-slim AS build

WORKDIR /build

# pnpm is required by the workspace tooling.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Install dependencies first so the layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json tsconfig.host.json tsconfig.client.json ./
COPY vendor ./vendor
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY native ./native
COPY website ./website
COPY examples ./examples
RUN pnpm install --frozen-lockfile

# Build the host/client library and the Web frontend. `dsh web` needs the
# built frontend dist (apps/web) to serve the GUI to each user, and every
# package's lib/ so the CLI and its bundles resolve through package exports.
RUN pnpm run build

FROM node:22-slim AS runtime

WORKDIR /srv

# Copy the built workspace plus the dependency store so the bin resolves.
COPY --from=build /build /srv

# The per-user instances run `dsh web`; expose the CLI bin under its canonical
# name (apps/cli's package `bin` is `dsh`, but workspace members do not link
# into the root .bin, so create the link explicitly).
RUN ln -s /srv/apps/cli/lib/bin.js /usr/local/bin/dsh

# Gateway state (users, sessions, per-user DSH homes, workspaces) lives here.
VOLUME ["/data"]

EXPOSE 3080

ENTRYPOINT ["node", "/srv/packages/host/web-gateway/lib/bin.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3080", "--data-root", "/data"]
