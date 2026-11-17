// 打包插件浏览器模块 → lib/client.js（DSH ModuleLoader 格式）。
// 外部依赖策略照官方插件：react 系与 @deepseek-ai/* 走运行时 require，其余全部 bundle。
// rolldown 解析顺序：插件本地 node_modules → dsh-desktop-next 的副本（免安装可跑）。
// 用法：node build/client.mjs
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const rolldownCandidates = [
  new URL('./node_modules/rolldown/dist/index.mjs', import.meta.url).href,
  'file:///F:/GIT_CODE/Github/dsh-desktop/dsh-desktop-next/node_modules/rolldown/dist/index.mjs',
]
let build
for (const url of rolldownCandidates) {
  try { ({ build } = await import(url)); break } catch { /* try the next candidate */ }
}
if (build === undefined) throw new Error('rolldown not found: install it or point build/client.mjs at a copy')

/** `?raw` imports (the disclaimer Markdown) become string modules, like vite's raw loader. */
const rawPlugin = {
  name: 'raw-strings',
  resolveId(source, importer) {
    if (!source.endsWith('?raw')) return undefined
    return resolve(dirname(importer ?? pluginRoot), source)
  },
  load(id) {
    return id.endsWith('?raw')
      ? `export default ${JSON.stringify(readFileSync(id.slice(0, -'?raw'.length), 'utf8'))}`
      : undefined
  },
}

const result = await build({
  input: resolve(pluginRoot, 'client', 'index.client.ts'),
  plugins: [rawPlugin],
  external: (id) => id === 'react' || id.startsWith('react/') || id.startsWith('@deepseek-ai/'),
  // 图标库打进产物：DSH 的模块加载器只提供官方包，lucide-react 从 dsh-desktop-next 的副本解析。
  resolve: {
    alias: {
      'lucide-react': 'F:/GIT_CODE/Github/dsh-desktop/dsh-desktop-next/node_modules/lucide-react/dist/cjs/lucide-react.js',
    },
  },
  output: {
    format: 'cjs',
    // 入口导出 apply/inject；外层工厂把它们挂到 module.exports（ModuleLoader 的插件约定）。
    exports: 'named',
  },
})

const code = result.output[0].code
const body = [
  'window.__ModuleLoader__.load({',
  '  id: "mt5-bridge-panel",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  code,
  '    return module.exports;',
  '  }',
  '});',
  '',
].join('\n')
const outFile = resolve(pluginRoot, 'lib', 'client.js')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, body)
console.log(`[build-client] ${outFile} (${(body.length / 1024).toFixed(0)} KiB)`)

// host 侧纯 ESM 无编译需求：与浏览器模块并排进 lib/（package.json 的 main 指向 lib/index.js）。
copyFileSync(resolve(pluginRoot, 'host', 'index.mjs'), resolve(pluginRoot, 'lib', 'index.js'))
copyFileSync(resolve(pluginRoot, 'host', 'deploy-engine.mjs'), resolve(pluginRoot, 'lib', 'deploy-engine.mjs'))
console.log('[build-client] lib/index.js + lib/deploy-engine.mjs (host side)')
