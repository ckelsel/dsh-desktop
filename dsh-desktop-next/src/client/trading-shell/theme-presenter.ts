/**
 * Theme DOM writes the official layout performs and the trading workspace takes over while that
 * layout is disabled. Same output as ui-layout 0.2.2's ThemePresenter: root `color-scheme` and
 * theme source, `body[data-ds-dark-theme]`, font size and family variables, the active theme's
 * token overrides, and one owned `meta[name="theme-color"]`. Only values this presenter wrote are
 * retracted.
 */
import type { FontRole, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

const DARK_ATTRIBUTE = 'data-ds-dark-theme'
/** Read by the Electron preload to mirror the theme into `nativeTheme.themeSource`. */
const THEME_SOURCE_ATTRIBUTE = 'data-ds-theme-source'
const FONT_SIZE_VARIABLES = {
  text: '--dsh-content-font-size',
  code: '--dsh-code-font-size',
  terminal: '--dsh-terminal-font-size',
} as const satisfies Record<FontRole, string>
const FONT_FAMILY_VARIABLES = {
  text: '--dsh-font-family-text',
  code: '--dsh-font-family-code',
  terminal: '--dsh-font-family-terminal',
} as const satisfies Record<FontRole, string>

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class TradingThemePresenter {
  private appliedTokens: string[] = []
  private readonly themeColorMeta: HTMLMetaElement

  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  /**
   * Project a resolved snapshot onto the document.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    document.documentElement.setAttribute(THEME_SOURCE_ATTRIBUTE, snapshot.preference === 'system' ? 'system' : scheme)
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    for (const [role, name] of Object.entries(FONT_SIZE_VARIABLES)) {
      body.style.setProperty(name, `${snapshot.fontSizes[role as FontRole]}px`)
    }
    for (const [role, name] of Object.entries(FONT_FAMILY_VARIABLES)) {
      const list = snapshot.fontFamilies[role as FontRole]
      if (list === '') body.style.removeProperty(name)
      else body.style.setProperty(name, list)
    }
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /** Retract everything {@link apply} wrote. */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    document.documentElement.removeAttribute(THEME_SOURCE_ATTRIBUTE)
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of Object.values(FONT_SIZE_VARIABLES)) body.style.removeProperty(name)
    for (const name of Object.values(FONT_FAMILY_VARIABLES)) body.style.removeProperty(name)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    this.themeColorMeta.remove()
  }
}
