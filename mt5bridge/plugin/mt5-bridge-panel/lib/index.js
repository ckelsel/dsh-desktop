/** Host plugin body: the deploy engine waits here until the wizard page asks for it. */
export { scanTerminals, readManifest, deploymentState, installDist } from './deploy-engine.mjs'

export const name = 'mt5-bridge-panel-host'

export function apply() {
  /* The browser entry owns everything users see; the host side grows the deploy service next. */
}
