# --- Web ---------------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Server ------------------------------------------------------------------
FROM rust:1-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /server
# Build the dependency graph on its own layer so a source-only change does not
# recompile every crate.
COPY server/Cargo.toml server/Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
# Cargo skips a rebuild when only mtimes look stale; force it for our own crate.
RUN touch src/main.rs && cargo build --release

# --- Runtime -----------------------------------------------------------------
FROM alpine:3.21
RUN adduser -D -u 10001 agmeet
WORKDIR /app
COPY --from=server /server/target/release/agmeet-server /usr/local/bin/agmeet-server
COPY --from=web /web/dist ./web/dist
USER agmeet

ENV AGMEET_BIND=0.0.0.0:8080 \
    AGMEET_STATIC_DIR=/app/web/dist
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["agmeet-server"]
