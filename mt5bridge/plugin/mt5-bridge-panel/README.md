# MT5 Bridge Panel（DSH 插件）

把 MT5 行情/交易页面与终端部署向导作为**独立 DSH 插件**交付：侧边栏入口、全局面板
挂载全部走 DSH 官方槽位协议，DSH 应用源码零改动。

## 能力

- **行情页**（官方全局面板）：图表（TradingView）/ 自选列表 / 下单 / 交易面板，
  数据经 DSH 桌面端的 MT5 桥通道（`window.dshMt5`）取自 MT5 终端
- **部署向导**（后续）：发现本机 MT5 终端 → 内置产物一键落盘 → 人工步骤清单 → 连接验证
- **部署引擎**：纯 Node（扫描终端 / 判定 absent-stale-installed / 校验安装）

## 布局

```text
client/          浏览器侧源码（行情页 + 免责声明 + 桥契约类型 + 插件入口）
build/client.mjs 打包 → lib/client.js（DSH ModuleLoader 格式，外部依赖白名单同官方插件）
host/            host 侧：index.mjs 壳 + deploy-engine.mjs 部署引擎
assets/          内置产物包（scripts/package-dist.mjs 生成：manifest + files）
lib/             构建产物（入库分发）
```

## 构建与打包

```bash
node build/client.mjs        # 浏览器模块 → lib/client.js（rolldown，借用 dsh-desktop-next 副本）
node ../../scripts/package-dist.mjs   # MT5 侧产物 → assets/bridge-dist
```

## 产物源（三档，先做第一档）

1. **内置**：`assets/bridge-dist/`（随本仓库分发）
2. 网络下载：后续从清单地址拉取（manifest 结构不变）
3. 手动导入：用户自行下载产物包，向导中选择目录

## 部署状态与页面显示约定

- `absent`：终端里没有桥文件 → 行情面板不注册，只注册部署向导入口
- `stale`：有旧版文件 → 向导提示升级
- `installed`：文件齐全且校验一致 → 行情面板按桥连接状态注册

## 手工步骤边界（MT5 硬边界，插件只能引导不能代点）

装完文件后，MT5 界面内仍需人工：① 设置里允许 DLL 导入 ② 导航器添加 BridgeService 服务
③ 开 M15 图表套 BridgeMarket 模板。向导以清单形式引导并逐项检测完成情况。
