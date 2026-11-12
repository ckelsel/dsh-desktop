/** Preferences remain readable when no Host or user plugin can start. */
import { join } from 'node:path'
import { DEFAULT_PREFERENCES, type DesktopPreferences } from './desktop-contract.ts'
import { atomicJson, readPrivateFile } from './private-files.ts'

export function parsePreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Desktop preferences')
  const source = { ...value as Record<string, unknown> }
  // An older Beta kept an MT5 address allowlist. The EA's own settings decide where it
  // connects now, so old preference files stay readable and drop the key.
  delete source.mt5AllowedAddresses
  if (Object.keys(source).some(key => !(key in DEFAULT_PREFERENCES))) throw new Error('Unknown Desktop preference')
  const result = { ...DEFAULT_PREFERENCES, ...source }
  // Acrylic and Mica were removed like in the original Desktop. Old preference
  // files stay readable and fail closed to the ordinary opaque Windows window.
  if (source.windowsMaterial === 'acrylic' || source.windowsMaterial === 'mica') result.windowsMaterial = 'off'
  for (const key of ['developerLogging', 'sidebarFooterCompat', 'sidebarFooterBalanced', 'closeToTray', 'browserAccess', 'notifications', 'turnCompleted', 'turnFailed', 'jobCompleted', 'jobFailed', 'scheduleCompleted', 'scheduleFailed', 'mt5Enabled'] as const) {
    if (typeof result[key] !== 'boolean') throw new Error(`Invalid Desktop preference: ${key}`)
  }
  for (const [key, choices] of Object.entries({ macosMaterial: ['off', 'transparent'], windowsMaterial: ['off'],
    linuxMaterial: ['off', 'transparent'], networkExposure: ['loopback', 'lan'], logLevel: ['debug', 'info', 'warn', 'error'],
    layoutMode: ['compatibility', 'trading'], mt5Exposure: ['loopback', 'lan'] })) {
    if (!choices.includes(String(result[key as keyof DesktopPreferences]))) throw new Error(`Invalid Desktop preference: ${key}`)
  }
  for (const key of ['port', 'lanPort'] as const) {
    if (typeof result[key] !== 'number' || !Number.isInteger(result[key]) || result[key] < 0 || result[key] > 65535) {
      throw new Error('Port must be an integer from 0 through 65535')
    }
  }
  // The EA dials a fixed port, so the operating system may not choose one.
  if (typeof result.mt5Port !== 'number' || !Number.isInteger(result.mt5Port) || result.mt5Port < 1 || result.mt5Port > 65535) {
    throw new Error('The MT5 port must be an integer from 1 through 65535')
  }
  for (const key of ['mt5DisclaimerVersion', 'mt5DisclaimerAcceptedAt'] as const) {
    if (typeof result[key] !== 'number' || !Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error(`Invalid Desktop preference: ${key}`)
  }
  // The upstream compatibility client paints an opaque background, so a transparent Linux
  // frame stays invisible. Fail closed to the solid frame exactly like the existing Desktop.
  return { ...result, linuxMaterial: 'off', jobCompleted: false, jobFailed: false } as DesktopPreferences
}

export function portsChanged(previous: DesktopPreferences, next: DesktopPreferences): boolean {
  return (['port', 'lanPort'] as const).some(key => previous[key] !== next[key])
}

/** The Host composes its client layout at startup, so a layout change needs a Host restart. */
export function layoutChanged(previous: DesktopPreferences, next: DesktopPreferences): boolean {
  return previous.layoutMode !== next.layoutMode
}

export class DesktopPreferenceStore {
  readonly file: string
  constructor(home: string) { this.file = join(home, 'desktop-preferences.json') }
  read(): DesktopPreferences {
    const text = readPrivateFile(this.file)
    return text === undefined ? { ...DEFAULT_PREFERENCES } : parsePreferences(JSON.parse(text))
  }
  write(value: unknown): DesktopPreferences {
    const preferences = parsePreferences(value)
    atomicJson(this.file, preferences)
    return preferences
  }
}
