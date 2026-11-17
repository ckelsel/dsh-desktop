/**
 * mt5-bridge-panel's browser entry: the market page as an official global panel.
 * The DSH plugin loader executes this module in the web renderer; `apply` registers the
 * page through the official slots (keyed 'main' + the sidebar panel list), so the sidebar
 * button and the panel's place in the frame are all this plugin's own doing — the shell
 * contributes nothing but the standard slots.
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerMarketPage } from './market/index.ts'

export const inject = ['slots', 'locale', 'theme']

export function apply(ctx: Context): void {
  registerMarketPage(ctx)
}
