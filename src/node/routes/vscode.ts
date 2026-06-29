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

function getStudentId(req: express.Request): string {
  return (req.headers["x-student-id"] as string) || ""
}

function getStudentDataDir(studentId: string): string {
  return path.join("/workspaces", `student_${studentId}`, ".code-server")
}

function getStudentExtensionsDir(): string {
  return "/workspaces/.shared-extensions"
}

function getStudentWorkspaceDir(studentId: string): string {
  return path.join("/workspaces", `student_${studentId}`)
}

/**
 * Load then create a VS Code server for a specific student.
 */
async function loadVSCode(req: express.Request, studentId: string): Promise<IVSCodeServerAPI> {
  let modPath = path.join(vsRootPath, "out/server-main.js")
  if (os.platform() === "win32") {
    modPath = "file:///" + modPath.replace(/\\/g, "/")
  }
  const mod = (await eval(`import("${modPath}")`)) as VSCodeModule
  const serverModule = await mod.loadCodeWithNls()
  return serverModule.createServer(null, {
    ...(await toCodeArgs(req.args)),
    "user-data-dir": getStudentDataDir(studentId),
    "extensions-dir": getStudentExtensionsDir(),
    "accept-server-license-terms": true,
    compatibility: "1.64",
    "without-connection-token": true,
  })
}

// Per-student VS Code server instances.
const vscodeServers = new Map<string, IVSCodeServerAPI>()
const vscodeServersLoading = new Map<string, Promise<IVSCodeServerAPI>>()

export const ensureStudentVSCodeLoaded = async (
  req: express.Request,
  _: express.Response,
  next: express.NextFunction,
): Promise<void> => {
  const studentId = getStudentId(req)
  if (!studentId) {
    return next()
  }

  if (vscodeServers.has(studentId)) {
    return next()
  }

  if (!vscodeServersLoading.has(studentId)) {
    vscodeServersLoading.set(studentId, loadVSCode(req, studentId))
  }

  try {
    vscodeServers.set(studentId, await vscodeServersLoading.get(studentId)!)
  } catch (error) {
    vscodeServersLoading.delete(studentId)
    logError(logger, "CodeServerRouteWrapper", error)
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

router.get("/", ensureStudentVSCodeLoaded, async (req, res, next) => {
  const isAuthenticated = await authenticated(req)
  const NO_FOLDER_OR_WORKSPACE_QUERY = !req.query.folder && !req.query.workspace
  const FOLDER_OR_WORKSPACE_WAS_CLOSED = req.query.ew

  if (!isAuthenticated) {
    const to = self(req)
    return redirect(req, res, "login", {
      to: to !== "/" ? to : undefined,
    })
  }

  if ((NO_FOLDER_OR_WORKSPACE_QUERY || FOLDER_OR_WORKSPACE_WAS_CLOSED)) {
    const studentId = getStudentId(req)
    const to = self(req)

    if (studentId) {
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

const mintKeyPromises = new Map<string, Promise<Buffer>>()
router.post("/mint-key", async (req, res) => {
  const studentId = getStudentId(req)

  if (!mintKeyPromises.has(studentId)) {
    mintKeyPromises.set(
      studentId,
      new Promise(async (resolve) => {
        const keyPath = path.join(getStudentDataDir(studentId), "serve-web-key-half")
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
      }),
    )
  }
  const key = await mintKeyPromises.get(studentId)!
  res.end(key)
})

router.all(/.*/, ensureAuthenticated, ensureStudentVSCodeLoaded, async (req, res) => {
  const studentId = getStudentId(req)
  if (studentId) {
    vscodeServers.get(studentId)!.handleRequest(req, res)
  } else {
    // Fallback for requests without student header: use the first available
    // server or the one created by the first user.
    const first = vscodeServers.values().next().value
    if (first) {
      first.handleRequest(req, res)
    } else {
      res.status(503).send("No VS Code server available")
    }
  }
})

const socketProxyProvider = new SocketProxyProvider()
wsRouter.ws(
  /.*/,
  ensureOrigin,
  ensureAuthenticated,
  ensureStudentVSCodeLoaded,
  async (req: WebsocketRequest) => {
    const studentId = getStudentId(req)
    const server = studentId ? vscodeServers.get(studentId) : undefined

    if (server) {
      const wrappedSocket = await socketProxyProvider.createProxy(req.ws)
      server.handleUpgrade(req, wrappedSocket as net.Socket)
      req.ws.resume()
    } else {
      // Fallback: use the first available server.
      const first = vscodeServers.values().next().value
      if (first) {
        const wrappedSocket = await socketProxyProvider.createProxy(req.ws)
        first.handleUpgrade(req, wrappedSocket as net.Socket)
        req.ws.resume()
      } else {
        req.ws.destroy()
      }
    }
  },
)

export function dispose() {
  for (const server of vscodeServers.values()) {
    server.dispose()
  }
  vscodeServers.clear()
  vscodeServersLoading.clear()
  socketProxyProvider.stop()
}
