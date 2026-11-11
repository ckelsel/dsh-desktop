import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveTradingViewRoot, serveTradingViewAsset, TRADINGVIEW_DIR_VARIABLE } from '../src/tradingview-assets.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function libraryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-tradingview-'))
  roots.push(root)
  await mkdir(join(root, 'charting_library', 'bundles'), { recursive: true })
  await writeFile(join(root, 'charting_library', 'charting_library.standalone.js'), 'globalThis.TradingView = {}')
  await writeFile(join(root, 'charting_library', 'sameorigin.html'), '<html><head></head><body></body></html>')
  await writeFile(join(root, 'charting_library', 'bundles', 'dot.cur'), new Uint8Array([0, 0, 2, 0]))
  await writeFile(join(root, 'charting_library', 'bundles', 'theme.css'), 'body{}')
  await writeFile(join(root, 'SOURCE.txt'), 'private sibling')
  return root
}

it('prefers an explicit directory and otherwise finds the vendored copy beside the package', () => {
  const entry = (directory: string) => join(directory, 'charting_library', 'charting_library.standalone.js')
  const packageRoot = resolve('/repo/dsh-desktop-next')
  const vendored = resolve('/repo/vendor/tradingview')
  const packaged = resolve('/app/resources/tradingview')
  const present = new Set([entry(vendored), entry(packaged), entry(resolve('/custom'))])
  const exists = (path: string) => present.has(path)
  expect(resolveTradingViewRoot({ packageRoot, env: {}, exists })).toBe(vendored)
  expect(resolveTradingViewRoot({ packageRoot, env: { [TRADINGVIEW_DIR_VARIABLE]: '/custom' }, exists })).toBe(resolve('/custom'))
  // A mistyped override must surface as "not found" rather than silently serving another copy.
  expect(resolveTradingViewRoot({ packageRoot, env: { [TRADINGVIEW_DIR_VARIABLE]: '/typo' }, exists })).toBeUndefined()
  present.delete(entry(vendored))
  expect(resolveTradingViewRoot({ packageRoot, resourcesPath: resolve('/app/resources'), env: {}, exists })).toBe(packaged)
  expect(resolveTradingViewRoot({ packageRoot, env: {}, exists })).toBeUndefined()
})

it('serves library files same-origin with their media types', async () => {
  const root = await libraryRoot()
  const entry = await serveTradingViewAsset(new Request('dsh-app://app/charting_library/charting_library.standalone.js'), root)
  expect(entry.status).toBe(200)
  expect(entry.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(await entry.text()).toContain('TradingView')
  const frame = await serveTradingViewAsset(new Request('dsh-app://app/charting_library/sameorigin.html'), root)
  expect(frame.headers.get('content-type')).toBe('text/html; charset=utf-8')
  // The library frame is not the application index: no boot carrier is injected into it.
  expect(await frame.text()).not.toContain('__DSH_BOOT_READY__')
  expect((await serveTradingViewAsset(new Request('dsh-app://app/charting_library/bundles/dot.cur'), root)).headers.get('content-type')).toBe('image/x-icon')
  expect((await serveTradingViewAsset(new Request('dsh-app://app/charting_library/bundles/theme.css'), root)).headers.get('content-type')).toBe('text/css; charset=utf-8')
  const head = await serveTradingViewAsset(new Request('dsh-app://app/charting_library/bundles/theme.css', { method: 'HEAD' }), root)
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
})

it('confines requests to the library directory and reports a missing library', async () => {
  const root = await libraryRoot()
  expect((await serveTradingViewAsset(new Request('dsh-app://app/charting_library/%2e%2e%2fSOURCE.txt'), root)).status).toBe(403)
  expect((await serveTradingViewAsset(new Request('dsh-app://app/charting_library/missing.js'), root)).status).toBe(404)
  expect((await serveTradingViewAsset(new Request('dsh-app://app/charting_library/charting_library.standalone.js', { method: 'POST' }), root)).status).toBe(405)
  expect((await serveTradingViewAsset(new Request('dsh-app://app/charting_library/charting_library.standalone.js'), undefined)).status).toBe(404)
  expect((await serveTradingViewAsset(new Request('dsh-app://app/assets/entry.js'), root)).status).toBe(404)
})
