/** Same-origin TradingView Advanced Charts assets for the application window. */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { serveWebDocument } from './web-document.ts'

/**
 * URL prefix the renderer loads the library from. The application page's origin is
 * `dsh-app://app`, and the library's iframe must share it (`iframe_loading_same_origin`).
 */
export const TRADINGVIEW_PATH_PREFIX = '/charting_library/'
/** Environment variable naming a directory that contains `charting_library/`. */
export const TRADINGVIEW_DIR_VARIABLE = 'DSH_TRADINGVIEW_DIR'
const LIBRARY_DIRECTORY = 'charting_library'
const LIBRARY_ENTRY = join(LIBRARY_DIRECTORY, 'charting_library.standalone.js')

/** Inputs for {@link resolveTradingViewRoot}; the defaults read the live process. */
export interface TradingViewRootOptions {
  /** Desktop package directory; a development tree keeps the vendored copy at `../vendor/tradingview`. */
  packageRoot: string
  /** Electron's resources directory, where a packaged build would place `tradingview/`. */
  resourcesPath?: string
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

/**
 * Locate the directory holding `charting_library/`. An explicit override is used alone, so a
 * mistyped path shows the renderer's "library not found" state instead of another copy.
 * @returns the directory, or undefined when no candidate carries the standalone entry.
 */
export function resolveTradingViewRoot(options: TradingViewRootOptions): string | undefined {
  const exists = options.exists ?? existsSync
  const override = (options.env ?? process.env)[TRADINGVIEW_DIR_VARIABLE]?.trim()
  const candidates = override ? [resolve(override)] : [
    resolve(options.packageRoot, '..', 'vendor', 'tradingview'),
    ...(options.resourcesPath ? [resolve(options.resourcesPath, 'tradingview')] : []),
  ]
  return candidates.find(directory => exists(join(directory, LIBRARY_ENTRY)))
}

/**
 * Serve one library file. The prefix is stripped before resolution, so the served tree is
 * `charting_library/` itself and an encoded `..` cannot reach its siblings.
 * @param request - Application request whose path starts with {@link TRADINGVIEW_PATH_PREFIX}.
 * @param root - Directory from {@link resolveTradingViewRoot}, or undefined when absent.
 */
export async function serveTradingViewAsset(request: Request, root: string | undefined): Promise<Response> {
  const url = new URL(request.url)
  if (root === undefined || !url.pathname.startsWith(TRADINGVIEW_PATH_PREFIX)) return new Response(null, { status: 404 })
  const inner = new URL(url.pathname.slice(TRADINGVIEW_PATH_PREFIX.length - 1), url)
  return serveWebDocument(new Request(inner, { method: request.method }), join(root, LIBRARY_DIRECTORY), false)
}
