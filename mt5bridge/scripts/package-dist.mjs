// 一键打包 MT5 桥部署产物 → plugin/mt5-deploy-wizard/assets/bridge-dist/
// 产物源三档（内置/网络/手动）的第一档：本脚本把成品编译收进插件包，随仓库分发。
// 用法：node scripts/package-dist.mjs
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(import.meta.url), '..', '..')
const nativeDir = join(repo, 'native', 'mt5bridge')
const mql5Dir = join(repo, 'mql5')
const outDir = join(repo, 'plugin', 'mt5-bridge-panel', 'assets', 'bridge-dist')
const metaeditor = 'H:\\Program Files\\MetaTrader 5\\metaeditor64.exe'

const log = (step, detail) => console.log(`[package-dist] ${step}${detail ? `: ${detail}` : ''}`)

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts })

/** 部署产物 = 这五件。目标相对路径按 MT5 数据目录 MQL5 根展开（部署引擎照此落盘）。 */
const distFiles = [
  { source: () => join(nativeDir, 'target', 'release', 'mt5bridge.dll'), dest: 'Libraries/mt5bridge.dll', build: 'cargo' },
  { source: () => join(mql5Dir, 'Services', 'BridgeService.ex5'), dest: 'Services/BridgeService.ex5', build: 'service' },
  { source: () => join(mql5Dir, 'Experts', 'BridgeMarketEA.ex5'), dest: 'Experts/BridgeMarketEA.ex5', build: 'ea' },
  { source: () => join(mql5Dir, 'Templates', 'BridgeMarket.tpl'), dest: 'Templates/BridgeMarket.tpl' },
  { source: () => join(nativeDir, 'mt5bridge.ini.example'), dest: 'Libraries/mt5bridge.ini' },
]

const cargoVersion = () => {
  const text = readFileSync(join(nativeDir, 'Cargo.toml'), 'utf8')
  const match = text.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('Cargo.toml missing version')
  return match[1]
}

const compileMql5 = (mq5Path) => {
  // /inc 指向仓库 mql5 根：MetaEditor 自动在 /inc 后拼 Include，仓库内 Include/Bridge 由此解析。
  // 退出码不可信：只要有 warning 就返回 1，成败以日志结果行为准。
  const logPath = join(repo, 'compile-package.log')
  try {
    run(metaeditor, [`/compile:${mq5Path}`, `/inc:${mql5Dir}`, `/log:${logPath}`])
  } catch (error) {
    if (error.code !== 'ENOENT') { /* 有 warning 的成功编译也走非零退出码 */ }
    else throw error
  }
  const text = readFileSync(logPath, 'utf16le')
  rmSync(logPath, { force: true })
  // 结果行形如 "Result: 0 errors, 2 warnings, 7518 ms elapsed"；非 0 errors 即失败。
  const line = text.split(/\r?\n/).find((row) => /^Result:/i.test(row.trim()))
  if (!line || !/\b0 errors\b/i.test(line)) throw new Error(`compile failed: ${line ?? 'no result line'}`)
  return line.trim()
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// ── 编译 ──
log('cargo build --release')
run('cargo', ['build', '--release'], { cwd: nativeDir })
for (const mq5 of ['Services/BridgeService.mq5', 'Experts/BridgeMarketEA.mq5']) {
  const result = compileMql5(join(mql5Dir, mq5))
  log('metaeditor', `${mq5} -> ${result}`)
}

// ── 收集 + 清单 ──
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'files'), { recursive: true })
const version = cargoVersion()
const commit = run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }).trim()
const entries = distFiles.map((file) => {
  const source = file.source()
  copyFileSync(source, join(outDir, 'files', basename(source)))
  return { path: file.dest, name: basename(source), bytes: statSync(source).size, sha256: sha256(source) }
})

const manifest = {
  // dist 版本跟随桥 DLL（协议主权在 DLL）；兼容的 node-sdk 版本单独记录。
  version,
  sdk_version: JSON.parse(readFileSync(join(repo, 'node-sdk', 'package.json'), 'utf8')).version,
  commit,
  generated_at: new Date().toISOString(),
  files: entries,
}
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
log('done', `v${version} @ ${commit} -> ${outDir}`)
for (const entry of entries) console.log(`  ${entry.path.padEnd(28)} ${entry.bytes.toLocaleString()} B`)
