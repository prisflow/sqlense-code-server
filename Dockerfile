# Stage 1: 编译我们修改的 code-server TypeScript
FROM node:22-bookworm AS builder

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY typings/ typings/
COPY src/ src/

RUN npm ci --ignore-scripts && npx tsc && \
    if ! grep -q "^#!/usr/bin/env node" out/node/entry.js; then \
      sed -i "1s;^;#!/usr/bin/env node\n;" out/node/entry.js && chmod +x out/node/entry.js; \
    fi

# Stage 2: 下载上游 standalone release（自备 node_modules + VS Code + lib/node）
FROM node:22-bookworm AS release

WORKDIR /opt/sqlense-code-server
RUN curl -fsSL https://github.com/coder/code-server/releases/download/v4.99.3/code-server-4.99.3-linux-amd64.tar.gz \
    | tar xz --strip-components=1

COPY --from=builder /app/out/ /opt/sqlense-code-server/out/

# Stage 3: 运行期（SQLense 扩展由 sqlense 仓库 volume 注入 /workspaces/.shared-extensions/sqlense-vscode）
FROM debian:12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

COPY --from=release /opt/sqlense-code-server/ /opt/sqlense-code-server/

WORKDIR /opt/sqlense-code-server

EXPOSE 8443
ENTRYPOINT ["dumb-init", "/startup.sh"]
CMD ["--auth", "none", "--bind-addr", "0.0.0.0:8443", "--log", "error"]
