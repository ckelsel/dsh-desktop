import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { DEFAULT_PREFERENCES, SAFE_MODE_PREFERENCES } from '../src/desktop-contract.ts'
import { layoutChanged, parsePreferences } from '../src/desktop-preferences.ts'
import { loadNextProfile, NextProfiles, readNextProfilePatches, TRADING_LAYOUT_PATCHES } from '../src/profiles.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function profiles(): NextProfiles {
  const home = mkdtempSync(join(tmpdir(), 'dsh-next-trading-'))
  roots.push(home)
  return new NextProfiles(home)
}

it('defaults to the trading layout and keeps Safe Mode on the official one', () => {
  expect(DEFAULT_PREFERENCES.layoutMode).toBe('trading')
  expect(SAFE_MODE_PREFERENCES.layoutMode).toBe('compatibility')
  expect(parsePreferences({}).layoutMode).toBe('trading')
  expect(parsePreferences({ layoutMode: 'compatibility' }).layoutMode).toBe('compatibility')
  expect(() => parsePreferences({ layoutMode: 'advanced' })).toThrow('layoutMode')
  expect(layoutChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, layoutMode: 'compatibility' })).toBe(true)
  expect(layoutChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, closeToTray: false })).toBe(false)
})

it('replaces the official root layout only while the trading layout is composed', () => {
  const manager = profiles()
  const dir = manager.ensure('desktop')
  const overlayPath = join(dir, 'desktop-next.cordis.patch.json')
  const overlays = [fileURLToPath(new URL('../host.cordis.patch.yml', import.meta.url)), overlayPath]
  const row = (rows: ReturnType<typeof composeEntries>, id: string) => rows.find(entry => entry.id === id)

  loadNextProfile(dir, manager.home, undefined, undefined, 'trading')
  const trading = composeEntries([readNextProfilePatches(dir, manager.home, overlays)])
  expect(row(trading, 'ui-layout')?.disabled).toBe(true)
  expect(row(trading, 'ui-sidebar')?.disabled).toBeFalsy()
  expect(row(trading, 'ui-conversation')?.disabled).toBeFalsy()
  expect(row(trading, 'desktop-next-capabilities')?.disabled).toBeFalsy()
  expect(JSON.parse(readFileSync(overlayPath, 'utf8'))).toEqual(expect.arrayContaining([...TRADING_LAYOUT_PATCHES]))

  // The overlay is regenerated on every start: returning to compatibility drops the layout rows.
  loadNextProfile(dir, manager.home)
  const compatibility = composeEntries([readNextProfilePatches(dir, manager.home, overlays)])
  expect(row(compatibility, 'ui-layout')?.disabled).toBeFalsy()
  expect((JSON.parse(readFileSync(overlayPath, 'utf8')) as { id: string }[]).map(entry => entry.id)).toEqual(['agents-anywhere-bridge-next'])
})
