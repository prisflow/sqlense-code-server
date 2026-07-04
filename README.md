# sqlense-code-server

[code-server](https://github.com/coder/code-server) 的派生版本，专为 [SQLense](https://github.com/prisflow/sqlense) 数据库实验教学平台定制。

## 与上游的区别

| 维度 | 上游 code-server | sqlense-code-server |
|------|-----------------|---------------------|
| **用户模型** | 单用户，每个实例一个用户 | **多用户**，单容器通过 `X-Student-Id` header 路由到独立工作区 |
| **认证** | 内置密码认证 | `--auth none`，由 SQLense Auth Proxy 统一鉴权 |
| **部署方式** | npm 包 / 二进制 / Docker | **仅 Docker**，基于 upstream 的 standalone release 构建 |
| **扩展策略** | 内置预装 | SQLense VS Code 扩展通过 volume 挂载到 `shared-ext/sqlense-vscode` |
| **构建方式** | 完整构建 `lib/vscode` | 下载 prebuilt `reh-web` 包，仅打 patch |
| **CI/CD** | 完整测试链（lint/unit/e2e） | 仅 `docker build & push` |

## 构建

```bash
docker build -t sqlense-code-server .
```

镜像基于 `codercom/code-server` 的 standalone release，构建过程：
1. 下载对应版本的 `reh-web` 包
2. 应用多用户 patch
3. 打包为轻量 runtime 镜像

## 快速启动

详见 SQLense 主仓库的 `docker-compose.yml`。此镜像不独立使用。

## 版本号

版本号格式 `4.99.3-sqlense.x`，其中 `4.99.3` 是上游 code-server 版本，`x` 是 SQLense 派生迭代号。
