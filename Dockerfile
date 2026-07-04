# Stage 1: 编译我们修改的 code-server TypeScript
FROM node:22-bookworm AS builder

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY typings/ typings/
COPY ci/ ci/
COPY src/ src/

RUN npm ci --ignore-scripts && npm run build

# Stage 2: 下载上游 standalone release（自备 node_modules + VS Code + lib/node）
FROM node:22-bookworm AS release

WORKDIR /opt/sqlense-code-server
RUN curl -fsSL https://github.com/coder/code-server/releases/download/v4.99.3/code-server-4.99.3-linux-amd64.tar.gz \
    | tar xz --strip-components=1

COPY --from=builder /app/out/ /opt/sqlense-code-server/out/

# Stage 3: 预编译 SQLense 扩展依赖（从 --build-context ext-src 引入源码）
FROM node:22-alpine AS ext-builder
WORKDIR /ext
COPY --from=ext-src / ./
RUN npm install --omit=dev

# Stage 4: 运行期（只装 dumb-init，用捆绑的 lib/node）
FROM debian:12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspaces/.shared-extensions

COPY --from=release /opt/sqlense-code-server/ /opt/sqlense-code-server/
COPY --from=ext-builder /ext/ /workspaces/.shared-extensions/sqlense-vscode/

WORKDIR /opt/sqlense-code-server

EXPOSE 8443
ENTRYPOINT ["dumb-init", "/startup.sh"]
CMD ["--auth", "none", "--bind-addr", "0.0.0.0:8443", "--log", "error"]
