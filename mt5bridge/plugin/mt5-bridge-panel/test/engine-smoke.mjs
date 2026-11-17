// 对本机真实环境跑一遍扫描+状态判定，验证部署引擎（非自动化测试，实机冒烟）。
import { scanTerminals, readManifest, deploymentState } from '../host/deploy-engine.mjs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const pluginRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const distDir = join(pluginRoot, 'assets', 'bridge-dist')
const manifest = readManifest(distDir)
console.log('manifest', manifest ? `v${manifest.version} @ ${manifest.commit}, ${manifest.files.length} files` : 'MISSING')
for (const t of scanTerminals()) {
  const s = deploymentState(t, manifest, distDir)
  console.log(`${t.id.slice(0, 8)}… install=${t.installPath ?? '?'} -> ${s.state} (${s.present}/${s.expected} files, ${s.mismatched} stale)`)
}
