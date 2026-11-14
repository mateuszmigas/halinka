# The server with the portal: `halinka server`. Runners run on other machines.
# Build from the repo root: docker build -f infrastructure/Dockerfile .

FROM node:24.20.0-bookworm-slim AS build
WORKDIR /repo
RUN npm install --global pnpm@12.5.1
COPY . .
RUN pnpm install --frozen-lockfile --filter "halinka..."
RUN pnpm turbo build --filter=halinka
# The package that runners install from this server; the image runs the same files.
RUN pnpm --filter halinka pack --pack-destination /pack && mkdir /app && mv /pack/halinka-*.tgz /app/halinka.tgz
RUN tar -xzf /app/halinka.tgz -C /app --strip-components=1

FROM node:24.20.0-bookworm-slim
# FileLocks reads the start time of a process with `ps`. The server is pid 1 after each restart, so
# without `ps` it takes the lock of its old process as live and refuses to start.
RUN apt-get update && apt-get install --yes --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HALINKA_HOME=/data
WORKDIR /app
COPY --from=build /app /app
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7070
HEALTHCHECK --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:7070/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["server", "--host", "0.0.0.0"]
