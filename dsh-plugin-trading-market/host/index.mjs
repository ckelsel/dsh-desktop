/** Host plugin body. The browser entry owns everything users see; the host side stays empty until
 * a Desktop-only service is needed. */
export const name = 'dsh-plugin-trading-market-host'

export function apply() {
  /* Intentionally empty: the market page is a pure web plugin. */
}
