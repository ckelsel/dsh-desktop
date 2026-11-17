// MT5 桥部署引擎（纯 Node，无 dsh/Electron 依赖，可独立单测）。
// 职责：发现本机 MT5 终端 → 对照产物清单判定部署状态 → 把产物落进终端数据目录。
// 产物布局与 scripts/package-dist.mjs 约定：manifest.json + files/<name>，清单 path 按数据目录 MQL5 根展开。
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * 发现本机 MT5 终端数据目录。数据目录 = <appData>/MetaQuotes/Terminal/<hash-id>/，
 * 每个目录的 origin.txt 记录其安装程序路径——一台机器装多个 MT5 时靠它分辨。
 * @param appData - 用户 AppData/Roaming 目录；默认读环境变量。
 */
export function scanTerminals({ appData } = {}) {
  const roaming = appData ?? process.env.APPDATA
  if (!roaming) return []
  const terminalsRoot = join(roaming, 'MetaQuotes', 'Terminal')
  if (!existsSync(terminalsRoot)) return []
  const terminals = []
  for (const id of readdirSync(terminalsRoot, { withFileTypes: true })) {
    if (!id.isDirectory()) continue
    const dataDir = join(terminalsRoot, id.name)
    const origin = join(dataDir, 'origin.txt')
    if (!existsSync(origin) || !existsSync(join(dataDir, 'MQL5'))) continue
    // origin.txt 是 UTF-16 文本：安装程序完整路径（可执行），空/读失败则当未知安装。
    let installPath = null
    try {
      installPath = readFileSync(origin, 'utf16le').split('\0')[0].trim() || null
    } catch { /* 读不了的 origin 当未知处理 */ }
    terminals.push({ id: id.name, dataDir, installPath })
  }
  return terminals
}

/** 读产物包清单；目录不存在或清单非法返回 null（调用方落到别的产物源）。 */
export function readManifest(distDir) {
  const file = join(distDir, 'manifest.json')
  if (!existsSync(file)) return null
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) return null
    return manifest
  } catch { return null }
}

/**
 * 判定一个终端的桥部署状态，对照清单逐文件核对。
 * absent：一个都没有；stale：有旧文件（存在但缺失/哈希不符）；installed：五件齐且哈匹。
 */
export function deploymentState(terminal, manifest, distDir) {
  let present = 0, mismatched = 0
  for (const entry of manifest.files) {
    const target = join(terminal.dataDir, 'MQL5', ...entry.path.split('/'))
    if (!existsSync(target)) continue
    present++
    if (sha256(target) !== entry.sha256) mismatched++
  }
  const state = present === 0 ? 'absent' : mismatched === 0 && present === manifest.files.length ? 'installed' : 'stale'
  return { state, present, expected: manifest.files.length, mismatched }
}

/**
 * 把产物装进一个终端数据目录。终端开着时 DLL 被锁，拷贝报 EBUSY——向上抛，向导提示先关终端。
 * @returns 落盘明细：[{path, bytes}]；写入前建目录，写入后回读校验。
 */
export function installDist(terminal, distDir, manifest) {
  const written = []
  for (const entry of manifest.files) {
    const source = join(distDir, 'files', entry.name)
    const target = join(terminal.dataDir, 'MQL5', ...entry.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    if (sha256(target) !== entry.sha256) throw new Error(`hash mismatch after copy: ${entry.path}`)
    written.push({ path: entry.path, bytes: statSync(target).size })
  }
  return written
}
