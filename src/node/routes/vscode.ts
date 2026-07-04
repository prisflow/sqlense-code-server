import { logger } from "@coder/logger"
import * as crypto from "crypto"
import * as express from "express"
import { promises as fs } from "fs"
import * as http from "http"
import * as net from "net"
import * as path from "path"
import * as os from "os"
import { logError } from "../../common/util"
import { CodeArgs, toCodeArgs } from "../cli"
import { isDevMode, vsRootPath } from "../constants"
import { authenticated, ensureAuthenticated, ensureOrigin, redirect, replaceTemplates, self } from "../http"
import { SocketProxyProvider } from "../socket"
import { isFile } from "../util"
import { type WebsocketRequest, Router as WsRouter } from "../wsRouter"

export const router = express.Router()

export const wsRouter = WsRouter()

export interface IVSCodeServerAPI {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
  handleUpgrade(req: http.IncomingMessage, socket: net.Socket): void
  handleServerError(err: Error): void
  dispose(): void
}

export type VSCodeModule = {
  loadCodeWithNls(): Promise<{
    createServer(address: string | net.AddressInfo | null, args: CodeArgs): Promise<IVSCodeServerAPI>
    spawnCli(args: CodeArgs): Promise<void>
  }>
}

/**
 * Extract student ID from request header.
 */
function getStudentId(req: express.Request): string {
  return (req.headers["x-student-id"] as string) || ""
}

/**
 * Build per-student workspace directory path.
 */
function getStudentWorkspaceDir(studentId: string): string {
  return path.join("/workspaces", `student_${studentId}`)
}

/**
 * Build per-student .vscode/settings.json path.
 */
function getStudentSettingsPath(studentId: string): string {
  return path.join(getStudentWorkspaceDir(studentId), ".vscode", "settings.json")
}

/**
 * Lazily create per-student workspace settings by fetching student config
 * from the API server.
 */
async function ensureStudentWorkspace(studentId: string): Promise<void> {
  const settingsPath = getStudentSettingsPath(studentId)
  if (await isFile(settingsPath).catch(() => false)) {
    return
  }

  const apiUrl = process.env.API_SERVER_URL || "http://api-server:4000"
  let studentConfig: Record<string, string> | null = null

  try {
    const resp = await fetch(`${apiUrl}/api/students/${studentId}/workspace-env`)
    if (resp.ok) {
      const data = await resp.json()
      studentConfig = data.student
    }
  } catch (err) {
    logger.warn(`[vscode] Failed to fetch student config from API: ${err}`)
  }

  const displayName = studentConfig?.display_name || studentId
  const dbName = studentConfig?.pg_db_name || `db_student_${studentId}`
  const dbUser = studentConfig?.pg_role_name || `role_student_${studentId}`
  const dbPass = studentConfig?.cs_password || studentId
  const wsServer = process.env.WS_SERVER || "ws://websocket:3001"
  const pgHost = process.env.PG_HOST || "postgres"

  const workspaceDir = getStudentWorkspaceDir(studentId)
  const vscodeDir = path.join(workspaceDir, ".vscode")
  await fs.mkdir(vscodeDir, { recursive: true })

  const settings = {
    "sqlense.wsServer": wsServer,
    "sqlense.studentId": studentId,
    "sqlense.studentName": displayName,
    "sqltools.connections": [
      {
        name: "实验数据库",
        driver: "PostgreSQL",
        server: pgHost,
        port: 5432,
        database: dbName,
        username: dbUser,
        password: dbPass,
      },
    ],
  }

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8")
  logger.info(`[vscode] Created workspace settings for student ${studentId}`)
}

/**
 * Load then create the single VS Code server instance.
 */
async function loadVSCode(req: express.Request): Promise<IVSCodeServerAPI> {
  let modPath = path.join(vsRootPath, "out/server-main.js")
  if (os.platform() === "win32") {
    modPath = "file:///" + modPath.replace(/\\/g, "/")
  }
  const mod = (await eval(`import("${modPath}")`)) as VSCodeModule
  const serverModule = await mod.loadCodeWithNls()
  return serverModule.createServer(null, {
    ...(await toCodeArgs(req.args)),
    "extensions-dir": "/workspaces/.shared-extensions",
    "accept-server-license-terms": true,
    compatibility: "1.64",
    "without-connection-token": true,
  })
}

// Single VS Code server instance (lazily created on first request)
let vscodeServer: IVSCodeServerAPI | undefined
let vscodeServerPromise: Promise<IVSCodeServerAPI> | undefined

/**
 * Middleware that ensures the single VS Code server is loaded.
 */
async function ensureVSCodeLoaded(
  req: express.Request,
  _: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (vscodeServer) {
    return next()
  }

  if (!vscodeServerPromise) {
    vscodeServerPromise = loadVSCode(req)
  }

  try {
    vscodeServer = await vscodeServerPromise
  } catch (error) {
    vscodeServerPromise = undefined
    logError(logger, "CodeServerLoad", error)
    if (isDevMode) {
      return next(
        new Error(
          (error instanceof Error ? error.message : error) +
            " (Have you applied the patches? If so, VS Code may still be compiling)",
        ),
      )
    }
    return next(error)
  }

  return next()
}

router.get("/", ensureVSCodeLoaded, async (req, res, next) => {
  const isAuthenticated = await authenticated(req)
  const NO_FOLDER_OR_WORKSPACE_QUERY = !req.query.folder && !req.query.workspace
  const FOLDER_OR_WORKSPACE_WAS_CLOSED = req.query.ew

  if (!isAuthenticated) {
    const to = self(req)
    return redirect(req, res, "login", {
      to: to !== "/" ? to : undefined,
    })
  }

  if (NO_FOLDER_OR_WORKSPACE_QUERY || FOLDER_OR_WORKSPACE_WAS_CLOSED) {
    const studentId = getStudentId(req)
    const to = self(req)

    if (studentId) {
      await ensureStudentWorkspace(studentId)
      return redirect(req, res, to, {
        folder: getStudentWorkspaceDir(studentId),
      })
    }

    // No student header: fall back to the original single-user behavior.
    const settings = await req.settings.read()
    const lastOpened = settings.query || {}
    const IGNORE_LAST_OPENED = req.args["ignore-last-opened"]
    const HAS_LAST_OPENED_FOLDER_OR_WORKSPACE = lastOpened.folder || lastOpened.workspace
    const HAS_FOLDER_OR_WORKSPACE_FROM_CLI = req.args._.length > 0

    let folder = undefined
    let workspace = undefined

    if (HAS_LAST_OPENED_FOLDER_OR_WORKSPACE && !IGNORE_LAST_OPENED) {
      folder = lastOpened.folder
      workspace = lastOpened.workspace
    } else if (HAS_FOLDER_OR_WORKSPACE_FROM_CLI) {
      const lastEntry = path.resolve(req.args._[req.args._.length - 1])
      const entryIsFile = await isFile(lastEntry)

      if (entryIsFile && path.extname(lastEntry) === ".code-workspace") {
        workspace = lastEntry
      } else if (!entryIsFile) {
        folder = lastEntry
      }
    }

    if (folder || workspace) {
      return redirect(req, res, to, {
        folder,
        workspace,
      })
    }
  }

  await req.settings.write({ query: req.query })

  next()
})

router.get("/manifest.json", async (req, res) => {
  const appName = req.args["app-name"] || "code-server"
  res.writeHead(200, { "Content-Type": "application/manifest+json" })

  res.end(
    replaceTemplates(
      req,
      JSON.stringify(
        {
          name: appName,
          short_name: appName,
          start_url: ".",
          display: "fullscreen",
          display_override: ["window-controls-overlay"],
          description: "Run Code on a remote server.",
          icons: [192, 512].map((size) => ({
            src: `{{BASE}}/_static/src/browser/media/pwa-icon-${size}.png`,
            type: "image/png",
            sizes: `${size}x${size}`,
          })),
        },
        null,
        2,
      ),
    ),
  )
})

// Single mint-key for the whole server instance
let mintKeyPromise: Promise<Buffer> | undefined
router.post("/mint-key", async (req, res) => {
  if (!mintKeyPromise) {
    mintKeyPromise = new Promise(async (resolve) => {
      const keyPath = path.join(req.args["user-data-dir"] || "", "serve-web-key-half")
      logger.debug(`Reading server web key half from ${keyPath}`)
      try {
        resolve(await fs.readFile(keyPath))
        return
      } catch (error: any) {
        if (error.code !== "ENOENT") {
          logError(logger, `read ${keyPath}`, error)
        }
      }
      const key = crypto.randomBytes(32)
      try {
        await fs.writeFile(keyPath, key)
      } catch (error: any) {
        logError(logger, `write ${keyPath}`, error)
      }
      resolve(key)
    })
  }
  const key = await mintKeyPromise
  res.end(key)
})

router.all(/.*/, ensureAuthenticated, ensureVSCodeLoaded, async (req, res) => {
  vscodeServer!.handleRequest(req, res)
})

const socketProxyProvider = new SocketProxyProvider()
wsRouter.ws(
  /.*/,
  ensureOrigin,
  ensureAuthenticated,
  ensureVSCodeLoaded,
  async (req: WebsocketRequest) => {
    const wrappedSocket = await socketProxyProvider.createProxy(req.ws)
    vscodeServer!.handleUpgrade(req, wrappedSocket as net.Socket)
    req.ws.resume()
  },
)

export function dispose(): void {
  if (vscodeServer) {
    vscodeServer.dispose()
  }
  vscodeServer = undefined
  vscodeServerPromise = undefined
  socketProxyProvider.stop()
}
