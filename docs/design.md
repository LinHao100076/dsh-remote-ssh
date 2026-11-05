# dsh-remote-ssh · 设计方案 v0.1

> 目标：在 DSH 里提供「远程 SSH 服务器」体验 —— 侧边栏里看远端文件系统、开远端终端、本地改动自动上传、可从远端下载。
> 本文先给结论，再给依据，最后是问题清单与里程碑。
>
> 环境事实（已在本机核对）：DSH `0.2.0-rc.2`，`dsh-better-sidebar` `0.28.0`，Node 22.22，pnpm 9.15。
>
> **状态**：B 路线已实现并在真实 profile 里跑通，落地细节与验证覆盖见 §8。

---

## 1. 结论先行：这不是一个「SSH 客户端」，是三个问题的组合

拆开看你列的 5 条需求，其实是三件互相独立、可以分别落地的事：

| # | 需求 | 本质 | 依赖 |
|---|---|---|---|
| 1 | 远程终端 | 远端 PTY ↔ 浏览器 xterm 的字节流 | SSH `shell` channel + WebSocket |
| 2 | 远端文件系统 | 远端目录树 / 读写 | SSH `sftp` + 批量 exec |
| 3 | 路径映射 + 自动上传 | **本地工作区才是真相，远端是影子** | 文件监听 + 传输队列 + 冲突检测 |
| 4 | 侧边栏呈现 | 向 better-sidebar 注册 Tab | `ctx.betterSidebar.registerTab` |
| 5 | 与 better-sidebar 联动 | 同一套 tab / 文件打开语义互通 | 上面的 service API |

关键判断：**第 3 条决定了整个项目的形态**，而不是第 1、2 条。因为「自动上传 dsh 改的文件」隐含了一个前提——dsh 的 agent 仍然在**本地**工作区里改文件。那就意味着：

- agent 的 read / write / edit / bash 全部作用于本地；
- better-sidebar 的文件树、编辑器、Git 面板也全部读本地（见 §2.2，它们绕过了 `ctx.fs`）；
- 你的插件是一个**旁挂的镜像器 + 远端浏览器**，而不是"把 IDE 搬到远端"。

所以 v0.x 的定位建议写成一句话：**「本地工作区的远端影子 + 远端文件的只读/写入通道」**。这个定位不性感，但它是唯一能让现有生态（agent 工具、better-sidebar、Git 面板）全部保持一致的选择。

---

## 2. 两个必须先知道的平台事实

### 2.1 DSH 有「执行世界」抽象，理论上可以整体搬走

这是我在本机包里挖到的、决定长期路线的两件事：

```
%APPDATA%/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
├── dsh-fs/                    抽象类 FileSystem  → 挂到 ctx.fs
├── dsh-fs-local/              本地实现（node:fs）
├── dsh-subprocess/            抽象类 SubprocessRuntime → 挂到 ctx.subprocess
├── dsh-subprocess-local/      本地实现
├── dsh-api-terminal-controller/  用户终端，注入 ctx.subprocess
└── dsh-terminal/              agent 用的 PTY 注册表（可 registerBackend）
```

`dsh-subprocess` 的注释写得很明确：

> Abstract subprocess service. Subclass, implement `spawn`, and load the subclass as a plugin — it registers as `ctx.subprocess` (one implementation per context).

`dsh-api-terminal-controller` 的 `resolveShell(subprocess, …)` / `spawnTerminal(spec)` 也全部走这个 provider。**这意味着：只要实现一个 `SubprocessRuntime` 的 SSH 版本，DSH 自带的终端 Tab、agent 的终端工具、甚至 bash 工具就会自动跑在远端**——不用自己写 xterm 对接、不用自己管断线重连和屏幕恢复。

这是「VSCode Remote」在 DSH 里的等价物，而且成本比想象中低。但它有个硬伤，见下一条。

### 2.2 better-sidebar 绕过了 `ctx.fs`

```bash
$ grep -rn "ctx.fs\|ctx.subprocess" dsh-better-sidebar/src
（无结果）
```

它的文件树、编辑器、媒体路由都是 `node:fs/promises` 直连。所以：

- 就算你把 `ctx.fs` 换成远端实现，**better-sidebar 的文件树仍然显示本地文件**；
- agent 在远端改文件，用户在文件树里看不到变化；
- 两个"文件系统"会同时存在，形成 split-brain。

这就把路线劈成了两条，且**不能混着做**：

| | A. 执行世界替换 | B. 本地镜像 + 旁挂（推荐 v0.x） |
|---|---|---|
| agent 在哪跑 | 远端 | 本地 |
| 文件真相 | 远端 | 本地 |
| 自动上传 | 不需要（本来就在远端） | 核心功能 |
| better-sidebar 文件树 | 失效（仍看本地） | 完全正常 |
| 终端 | 宿主原生终端直接可用 | 自己写 xterm + WS |
| 多主机 | 单例服务，需切 profile | 天然多连接 |
| 工作量 | 中（但坑在边界条件） | 中（但坑在同步语义） |
| 风险 | 与生态割裂 | 双副本漂移 |

**建议：v0.x 走 B，把 A 作为 v1.0 的独立 profile 实验**（`dsh plugin --profile remote add …`，在 patch 里 disable `fs-local` / `subprocess-local`，插入自己的 provider）。两条路要在文档里写明互斥关系，否则后期会有人试图混用然后 debug 到崩溃。

---

## 3. 推荐架构（B 路线）

```
┌────────────────────────── 浏览器（client half） ──────────────────────────┐
│  better-sidebar 右侧栏                                                     │
│   └─ [远程] tab ──┬─ RemoteTree     文件树（sftp 懒加载 + 状态徽标）        │
│                   ├─ RemoteTerminal xterm.js + 帧回放                      │
│                   └─ SyncPanel      映射 / 队列 / 冲突                     │
└───────────────▲──────────────────────────────▲───────────────────────────┘
        hostRouteUrl('ssh/api/*')      WebSocket: ssh/ws/term · ssh/ws/fs
┌───────────────┴──────────────────────────────┴───────────────────────────┐
│  host half（插件进程内）                                                   │
│   ├─ ConnectionPool    一个 host 一条 ssh2.Client（多 channel 复用）        │
│   ├─ Auth              ssh config 解析 / 密钥 / agent / known_hosts         │
│   ├─ RemoteFs          sftp 读写 + exec 批量（tar 流）                      │
│   ├─ TermBridge        shell channel ↔ WS（二进制帧 + 背压）                │
│   ├─ SyncEngine        watch → 去抖 → 队列 → 原子写 → 冲突                  │
│   └─ SessionMap        sessionId → { hostId, mappings[] }                  │
└───────────────▲───────────────────────────────────────────────────────────┘
                │ chokidar / git status
        ┌───────┴────────┐
        │ 本地工作区      │  ← agent 在这里改文件
        └────────────────┘
```

### 3.1 目录结构

```
dsh-remote-ssh/
├── package.json          # dsh.bundle.patch + dsh.client.platform=web + peerDeps(better-sidebar, optional)
├── cordis.patch.yml      # insert: dsh-remote-ssh
├── tsdown.config.ts      # host chunk / client core / xterm 懒加载 chunk 三份产物
├── src/
│   ├── index.ts          # host 入口：routes + WS + tools
│   ├── ssh/
│   │   ├── config.ts     # ~/.ssh/config 解析（Host/Include/ProxyJump/IdentityFile）
│   │   ├── pool.ts       # 连接复用 + keepalive + 指数退避重连
│   │   ├── auth.ts       # 密钥 / agent / 密码；passphrase 仅内存
│   │   └── known-hosts.ts
│   ├── remote/
│   │   ├── fs-sftp.ts    # list/read/write/rename，写临时文件再 mv
│   │   ├── transfer.ts   # 单文件 sftp / 批量 tar over exec / 进度事件
│   │   └── exec.ts       # 短命令执行（远端探测、git、rg）
│   ├── sync/
│   │   ├── mapping.ts    # 映射解析、glob 覆盖、忽略规则
│   │   ├── watcher.ts    # chokidar + git 校准
│   │   ├── queue.ts      # 串行/并发上限、去重、取消
│   │   └── conflict.ts   # mtime+size+hash 三态判定
│   └── client/
│       ├── index.tsx     # 三个 registerTab + 设置声明
│       ├── hosts.tsx
│       ├── RemoteTree.tsx
│       ├── RemoteTerminal.tsx   # 懒加载 chunk
│       └── SyncPanel.tsx
└── ui/prototype.html     # 本目录的 UI 原型
```

### 3.2 与 better-sidebar 的接线（照抄即可）

```ts
import type {} from 'dsh-better-sidebar'
export const inject = ['betterSidebar']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'dsh-remote-ssh:files',
    title: () => '远程',
    order: 45,
    component: ({ scope, visible }) => <RemotePanel sessionId={scope.sessionId} visible={visible} />,
  }))
}
```

要点（都是踩过坑的）：

- **必须包在 `ctx.effect()`**，否则 HMR 后重复注册报 `tab type already registered`；
- 请求一律走 `ctx.betterSidebar.hostRouteUrl('ssh/api/...')`，**不要写 `/ssh/api/...`**，反代子路径部署会 404；
- `visible === false` 时暂停轮询和 fs 订阅；
- 用 `features.includes('hostRouteUrl')` 做能力门，插件市场和不同宿主版本会降级；
- 不要抢 `editor` / `terminal` 这些内置 type id，自己带包前缀。

---

## 4. 需要改进 / 决策的地方（这就是你问的「还有哪些要补」）

按「不做会返工」排序。每条都给结论，不给选项堆砌。

### P0 · 架构级

**1）先定「单向还是双向」**
默认**单向：本地 → 远端**。双向必须是显式开启、按映射逐个开、且带冲突闸门。双写是这类插件 90% 的 bug 来源（用户 git checkout 一下，远端全被覆盖）。

**2）传输层别只用 SFTP**
SFTP 每个目录一次 `readdir` 往返，深树在 200ms 延迟下会肉眼可见地卡。建议：
- 浏览：`sftp.readdir` 懒加载 + `fs.trees` 式批量（一次请求多层）；
- 单文件：`sftp` 写 `*.tmp` 再 `rename`（原子，避免远端进程读到半截文件）；
- 批量（首次全量、目录下载）：`tar -cf - . | tar -xf -` over exec，或直接 rsync（若远端有）。1000 个小文件能差 10 倍以上。

**3）终端的进程存活必须靠 tmux，不要靠自己**
WebSocket 一断，非 tmux 的远端 shell 就直接 SIGHUP。默认命令建议 `tmux new -A -s dsh`（-A = attach 或新建），并在设置里可关。这样浏览器刷新、DSH 重启都能接回原来的会话。
另外：ssh2 给的是 `Buffer`，务必用 `TextDecoder({ stream: true })` 解码，否则中文/emoji 会在 chunk 边界被切坏（这是最典型的"偶发乱码"）。

**4）凭据存储别自己造**
优先级：ssh-agent > 密钥文件 + 会话内缓存 passphrase > OS 加密存储（Windows DPAPI / macOS Keychain）。**不要**把密码或 passphrase 写进插件的 localStorage / JSON。known_hosts 必须校验，主机指纹变化要给显式红色告警（中间人）。UI 上要写清楚"私钥不出本机"。

**5）路径映射的语义要提前定死**
建议数据结构：

```ts
interface Mapping {
  id: string
  localRoot: string          // 绝对路径，Windows 统一正斜杠
  remoteRoot: string
  direction: 'push' | 'pull' | 'both'
  include?: string[]         // ['src/**', 'package.json']
  exclude?: string[]         // 继承 .gitignore + 默认 node_modules/.git/dist
  deletePolicy: 'never' | 'confirm'   // 默认 never
  modeTemplate?: string      // '0755' 用于 *.sh，Windows 本地没有 exec bit
}
```

Windows 上**没有 exec bit**，上传 `.sh` / 二进制后远端不可执行是最常见的"为什么跑不起来"。用 `modeTemplate` 按扩展名补 chmod。

### P1 · 会明显影响体验

**6）变更来源要三路合并，别只听文件系统**
`chokidar` 只能看到"本地变了"，看不到"远端被别人改了"。建议三路输入去重：
`chokidar` 事件（去抖 150–300ms）+ 定时 `git status --porcelain` 校准 + 传输完成后回写基线（mtime/size/hash）。
三态判定：`本地新 / 远端新 / 都新 → 冲突`。

**7）删除要当作危险操作**
本地删了文件，**默认不删远端**，进"待确认"队列。生产机器上一次误同步可以毁掉部署目录。

**8）大文件、二进制、产物目录**
单文件上限（建议 8 MB 默认）、`node_modules` / `.git` / `dist` / `*.map` 默认排除、二进制不做预览只给下载。队列要有并发上限（4–6）和总带宽感受（进度条 + 单文件耗时）。

**9）多主机 / 多会话的连接池**
一个 host 一条 `ssh2.Client`，多 channel 复用；同一 host 的不同 session 共享池；断线指数退避（1s→2s→4s→…上限 30s）+ 手动重连。UI 里主机切换必须是"切 tab"级别，不能重连。

**10）安全边界与生产保护**
远端命令以登录用户身份执行，等于给了插件完整权限。建议：只读模式（全局开关）、生产主机二次确认、危险命令（`rm -rf /`、`dd`、`mkfs`）拦截提示、日志脱敏（永远不打印密钥/密码/完整命令行参数里的 token）。

### P2 · 加分项

**11）端口转发**：`-L` 本地转发 + 复用宿主 browser tab 预览远端服务，是"远程开发"最高频的第二个需求。
**12）远端搜索**：`rg --json` over exec，结果直接定位到远端文件行；比本地镜像搜索更可信（远端可能有本地没有的文件）。
**13）执行世界模式**：见 §2.1，独立 profile，别和 B 混用。
**14）操作可观测**：每次传输/命令一个 trace id + "最近操作"面板，错误分类（认证/主机指纹/超时/磁盘满）并支持一键复制完整诊断。

---

## 5. UI 原型说明

`ui/prototype.html`（单文件，双击可开，可切深色）是**界面的唯一标准**：实现里所有面板都照着它做，配色、间距、信息密度都以它为准。

- 顶部状态切换：连接页 / 连接中 / 文件 / 终端 / 同步 / 转发 / 设置 / 错误 —— 都是真实会出现的界面，方便评审时逐条挑刺；
- 文件页：路径面包屑 + 懒加载树 + git 状态徽标 + "待上传"箭头 + 悬停操作（下载/上传）+ 底部文件预览条（含"在 better-sidebar 编辑器打开"这个联动入口）；
- 终端页：多 tab + 会话信息条 + 真实可输入的提示符（回车有回显演示）+ 快捷键提示；
- 同步页：映射卡片 / 策略分段控件 / 冲突卡片（三选一）/ 传输队列（带进度）/ 安全开关；
- 设置页：连接表单 + 映射表 + 行为开关 + 保存/测试；
- 底部状态栏固定显示：连接状态 · 映射数 · 队列数 · 传输协议。

设计取舍：宽度按 424px 真实右侧栏做，不做"大屏才好看"的布局；所有信息密度按"开发者一天要看 200 次"来压，不放大卡片和留白。面板宽度实际跟着右侧栏走，被拖宽时居中的状态页（连接门、空态）用 `max-width: 360px` 收成一条可读的列，而不是把密码框拉成 600px 宽。

### 5.1 配色只有一个来源

亮/暗两套色值原样取自原型，写进 `.rs-root` 的 `--rs-*` 变量，再用 `light-dark()` 绑到宿主的 `color-scheme`：

```css
@supports (color: light-dark(#ffffff, #000000)) {
  .rs-root { --rs-bg: light-dark(#ffffff, #15181e); --rs-accent: light-dark(#2f6feb, #6ba1ff); ... }
}
```

**没有沿用 `--dsw-alias-*`**。一开始是沿用的，装进真实 profile 才发现这套别名对面板不成立：品牌色是近黑 `#0f1115`（原型的强调色是蓝）、`border-l1` 是 4% 黑（分隔线等于消失）、`bg-layer-1` 与 `bg-base` 都是纯白（`surface` 与 `panel` 塌成一层，主机图标块看起来像没渲染）。跟着宿主走等于把原型的视觉语言全丢掉，而用户要的恰恰是"和原型一样"。宿主的字体族仍然沿用（`--ds-font-family-code`），所以等宽字体和编辑器一致。

xterm 的配色也改从这里取：`getPropertyValue` 拿到的是 `light-dark(...)` 文本，xterm 解析不了，所以 `client/terminal-view.jsx` 用一个隐藏探针元素把 token 换算成 `rgb()` 再交给它。

---

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | 包骨架 + patch + 一个空 Tab 挂进 better-sidebar | 侧边栏出现「远程」Tab |
| M1 | 连接池 + 认证 + known_hosts + 终端（xterm/WS/tmux） | 能在远端跑 `top`，刷新后接回原会话 |
| M2 | SFTP 树 + 预览 + 上下载 + 原子写 | 远端 10 万文件目录不卡死 |
| M3 | 映射 + 监听 + 队列 + 冲突 | 改一个文件 300ms 内到远端，冲突能拦 |
| M4 | better-sidebar 深度联动 + 设置页 + 多主机 | 从远端文件一键跳到本地编辑器 |
| M5 | 端口转发（`-L`）✅ / 远端搜索 | — |
| 实验 | 执行世界替换（`ctx.fs` + `ctx.subprocess`） | 独立 profile，agent 全程在远端 |

---

## 7. 三个问题的结论（已拍板）

| 问题 | 结论 |
|---|---|
| 默认方向 | 单向（本地 → 远端）+ 按映射开双向 |
| tmux 依赖 | **不强制**：有 tmux 就用 `tmux new -A`，没有就退回普通登录 shell 并明确提示（见 §8.3） |
| 是否现在做执行世界模式 | 不做。先按 B 路线交付，A 作为独立 profile 实验 |

---

## 8. 实现状态（B 版已落地）

### 8.1 代码落点

| 关注点 | 文件 |
|---|---|
| 宿主端装配、路由注册、可选的 agent 工具 | `src/index.js` |
| HTTP API 分发表（hosts / fs / transfer / sync / session / system） | `src/api.js` |
| 连接池、TOFU 指纹、ProxyJump、错误分类 | `src/ssh/pool.js` |
| 远端文件读写、二进制/体积/陈旧守卫、原子写 | `src/remote/files.js` |
| 上传下载、目录树、mode 映射 | `src/remote/transfer.js` |
| 映射、排除规则、glob 匹配 | `src/sync/mapping.js` |
| 监听、去抖、冲突判定、队列 | `src/sync/engine.js` |
| 端口转发（监听、direct-tcpip、生命周期） | `src/forward/manager.js` |
| 终端桥（WS ⇄ SSH PTY + tmux 判定） | `src/ws/term.js` |
| 状态持久化（密码不落盘） | `src/store.js` |
| 客户端装配：一个标签页 / 一个原生入口，两条路互斥 | `client/index.js` |
| 面板骨架：主机头（主机菜单）、标签条、门控、状态栏 | `client/workspace.jsx` |
| 连接门（无主机 / 连接中 / 失败 + 密码） | `client/connect-view.jsx` |
| 五个视图 | `client/files-view.jsx`、`terminal-view.jsx`、`sync-view.jsx`、`forward-view.jsx`、`settings-view.jsx` |
| 基础组件与图标集 | `client/ui.jsx` |
| 全部样式（`rs-` 前缀，单文件注入） | `client/styles.js` |

### 8.2 四个踩过的坑

1. **`ctx` 是 Proxy，不是对象**。访问未在 `inject` 里声明的服务会抛 `cannot get property "x" without inject`。我在 `system.ping` 里读了 `ctx.pluginVersion`，单测用的假 ctx 是普通对象所以全绿，真 profile 里直接 500。修法：版本从插件自身传入（`buildApi({ version })`），并且把单测的假 ctx 也换成同样会抛错的 Proxy —— 这类 bug 只有让测试环境同样严格才防得住。

2. **`registerTab` 对重复 id 会 `throw`**（`[dsh-better-sidebar] tab type "x" already registered`），且它的返回值才是 disposer。HMR 在旧 effect 销毁前重跑 `apply` 就会炸掉整个面板。修法：注册前用 `service.getTab(id)` 判断，已存在就跳过；`ctx.effect(() => service.registerTab(...))` 保留返回的 disposer。

3. **测试会悄悄跑在旧产物上。** 客户端代码写错时 `build.mjs` 失败，但 `npm test` 照样读上一次的 `lib/client.js` 全绿 —— 改完代码却看到绿灯，比红灯危险得多。修法：`package.json` 加 `"pretest": "node build.mjs"`，npm 会在 `test` 前自动跑，构建失败即中止。

4. **「可选依赖」被写成了「没有就隐藏」**（issue #1）。初见时把 better-sidebar 当唯一入口：服务不在就静默返回，于是停用 better-sidebar 后插件从侧边栏彻底消失。修法不是兜底提示，而是补一个**不依赖它**的入口——DSH 自带的右侧边栏（`ui-sidebar-right` 属于 `dsh-web-app` bundle，本来就在启动图里，better-sidebar 自己也只是往它里面注册 tab）。两条路径互斥，better-sidebar 后激活时交接。同时暴露了第 1 条坑的变体：`routeUrl` 里 `ctx?.betterSidebar` 在 Proxy 上仍然会抛，必须换成 `ctx.get('betterSidebar')`。

### 8.3 tmux 判定位置

判定放在 `attachTerminal` 里、每条连接现算，而不是保存主机时算一次 —— 远端可能中途装上 tmux，也可能换了台机器。探测和终端共用同一次 `files.info()` 执行（`uname` / `$SHELL` / `$HOME` / `command -v tmux`），一次往返拿到全部事实。

### 8.4 验证覆盖

| 测试 | 覆盖 | 命令 |
|---|---|---|
| `test/smoke.mjs` | 路由注册、主机增删、映射归一化、落盘无密码、排除规则、终端帧、未声明服务访问会抛错 | `node test/smoke.mjs` |
| `test/ssh.mjs` | 握手、密码认证、exec、PTY、TOFU 记录、改指纹报 `host-key-changed`、错密码报 `auth-failed`、连接复用 | `node test/ssh.mjs` |
| `test/files.mjs` | 列表排序、二进制/超大/陈旧守卫、原子写不留临时文件、mkdir 递归、rename、递归删除 | `node test/files.mjs` |
| `test/forward.mjs` | 真实 TCP 往返穿过 `direct-tcpip`、字节统计、同端口判重、端口被占、停止后拒绝连接、autoStart 语义、规则持久化无密码 | `node test/forward.mjs` |
| `test/render.mjs` | 用真实 React `renderToString` 渲染五个视图、连接门四态与原生工作区，断言密码输入与失败原因（issue #2），捕捉只在渲染期暴露的错误 | `node test/render.mjs` |
| `test/native.mjs` | 有 better-sidebar 时**一个**标签页（issue #1）、没有时原生类型/面板/头部按钮、后激活时交接、卸载无残留 | `node test/native.mjs` |
| `test/bundle-check.html` | 真实浏览器加载 bundle：一个标签页、order 46、title/icon 函数解析、重复挂载幂等、卸载后清空 | `chrome --headless=new --dump-dom …` |
| `test/e2e-profile.mjs` | 真实 DSH profile 内：路由挂载、cookie 准入、两条终端分支、PTY 往返、resize 不断连 | 见 README |
| `scripts/check-ssh.mjs` | 真实服务器：连接、UTF-8 读写、上传下载字节一致 | `node scripts/check-ssh.mjs` |

### 8.5 还没做的（有意留白）

- **执行世界替换（A 路线）**：`ctx.fs` / `ctx.subprocess` 换成远端实现，让 agent 全程在远端跑。前提是先让 better-sidebar 也不再直读本地，否则 split-brain。
- **远端搜索**：希望走远端 `rg` 而不是拉文件回来本地搜。
- **断点续传**：大文件目前是整包 `fastPut`，中断即重来。
- **端口转发的进阶能力**：`socks5` 动态转发、`-R` 反向转发当时都没做（`v0.6.0` 补上，见 §8.15）。

### 8.6 端口转发的三个取舍

1. **默认绑回环，公开绑定要显式选且会被标红。** 把数据库端口转到 `0.0.0.0` 等于把它接到咖啡厅的 Wi-Fi 上；默认值必须是安全的那个，危险动作必须多一次选择，并且在界面上一直可见（`exposed` 字段一路传到面板顶部横幅）。

2. **监听器比连接活得久。** SSH 掉线时不拆监听器 —— 池子会在下一条入站连接到达时惰性重连，所以用户的浏览器刷新两次不至于让隧道永久失效。代价是池子要在内存里留一份凭据（`#secrets`）：只存在于进程内，显式 `close()` 或插件卸载即清除，且状态文件里永远只有 `auth.type`。

3. **错误要分清「远端服务没起」和「SSH 断了」。** 前者是 `target-refused`（服务本身的问题，改远端），后者是传输层错误（改网络或认证）。混成一个「转发失败」，用户就不知道该去修哪一头。

### 8.7 为什么原生入口是「第二条路」而不是「兜底提示」

用户停用 better-sidebar 后，插件整条从侧边栏消失（issue #1）。第一反应是弹个「请安装 better-sidebar」的提示，但那等于把一个可选依赖升级成硬依赖。

翻 better-sidebar 的实现才发现它自己也只做了一件事：往 DSH **自带的** `ui-sidebar-right`（`dsh-web-app` bundle 里，和本插件毫无关系）注册 tab 类型与面板。也就是说，"在右侧边栏出现一个面板"这个能力本来就属于 DSH，不属于 better-sidebar。于是本插件直接用它：

- `sidebarRightTabs.register({ id, kind, priority: 'extension' })` —— 一个页类型，`kind` 就是包名；
- `sidebar.right.pane.tab` slot —— 面板本体，内部用一条自己的 tab 条切换四个 pane；
- `conversation.session.header.utilities` slot —— 会话头部的服务器图标，点一下 `sidebarRight.openTab(kind)`。

结果是不装 better-sidebar 也能用完整功能，装了就在 better-sidebar 里多一个同款标签页（一次只激活一种入口，避免两个同时出现）。`v0.3.0` 把标签页从四个收成一个：四份入口把侧栏挤满，而面板内部本来就有标签条（issue #1）。代价是面板里四个 pane 必须共用一块宽度：所以 pane 用 `hidden` 保活而不是卸载 —— 否则切到文件页看一眼，终端的 socket 和 tmux 附着就都没了。

### 8.8 界面重做：从「能用的面板」到原型本身（v0.3.0）

v0.2.1 能跑通全部功能，但界面和 `ui/prototype.html` 是两套东西：原型是主机头 + 下划线标签条 + 居中状态页 + 底部状态栏，实现里是四个各自独立的扁平面板，配色还是随手挑的。用户的原话是「完全就是两个 UI」。这一版不是调样式，是把界面按原型重写：

1. **一个组件，两个入口**。`client/workspace.jsx` 是唯一的面板，better-sidebar 标签页和原生右侧边栏都渲染它 —— 两个入口如果各写一份，视觉迟早再次分叉。
2. **面板内部用标签条，不用四个顶层标签页**。`文件 / 终端 / 同步 / 转发 / 设置` 是面板里的五个 pane，`文件` 与 `终端` 需要连接，未连上时被连接门挡住（`GATED`）。
3. **pane 用 `hidden` 保活**。切走不卸载：终端的 WebSocket、xterm 实例、tmux 附着都还在。卸载重建的代价是用户切去看一眼文件就把 shell 杀了。
4. **JSX 必须用经典运行时**。客户端的模块表只解析 `react`，`require('react/jsx-runtime')` 在这里解析不了，所以 `build.mjs` 配的是 `jsx: 'transform'` + `jsxFactory: 'h'`。自动运行时会编译成功、加载失败，报错还发生在 `__ModuleLoader__` 里，很难定位。
5. **样式单文件、`rs-` 前缀、`:where()` 降特异性**。面板和别的插件共用一份 document，`button { padding: 0 }` 这种 reset 会把 `.rs-btn` 的 padding 一起吃掉（曾经把「仅保存 / 测试连接」压成两个贴在一起的方块），改成 `.rs-root :where(button)` 后组件类才拿得回优先级。

顺手修掉的两个真实缺陷（都由 issue #2 暴露）：

- **密码没有输入的地方**。原实现只认密钥/agent，密码主机连不上时只报一句 `auth-failed`，用户无从下手。现在密码框出现在两处：连接门（认证方式是密码的主机直接显示，`autoFocus`，回车即连）和设置视图；密钥失败时还多一个「改用密码」把认证方式就地切过去。值只进内存（`secretStore`），永不落盘、不进日志。
- **没有切换主机的入口**。连接门里列出全部主机（当前主机用强调色描边），面板标题栏的主机名点开是主机菜单（在线徽标 + 新建 / 管理）。两处都能切，不用绕去设置页。

验证方式：`ui/preview.html`（不进包）用真实 React UMD 加载真实 `lib/client.js`，配假 API 与假 WebSocket，逐屏截图和原型比对；再用 CDP 驱动真实 DSH profile 截图复核 —— 亮色、暗色、连接门四态、五个视图都过了一遍。

### 8.9 宿主端也打包：让安装方式不再决定成败（v0.3.1）

0.3.0 发出去之后，用户在桌面应用里装出来的结果是「启用失败：1 entry did not activate — Cannot find package 'ssh2'」。原因不在代码：

- 他是把 tgz 解压到 `D:/temp/新建文件夹/package`，再从那个目录装的；
- pnpm 把本地目录写成 `link:`，而**链接进来的目录不会安装它自己的依赖**；
- 于是 `src/ssh/pool.js` 的 `import ssh2 from 'ssh2'` 在宿主端解析失败，整个插件被判定未激活；
- 同一条命令、同一个包，换成 `add -w <tgz>` 就是好的 —— pnpm 会把 tarball 的 `dependencies` 正常装进 `.pnpm`。

这属于「插件把自身结构暴露给了安装方式」。修法不是写文档提醒，是把宿主端也打成一个自包含的 bundle：

1. `build.mjs` 多产一个 `lib/server.mjs`（esbuild，`platform: node`，`format: esm`），入口仍是 `src/index.js`；`package.json` 的 `main` 与 `exports['.']` 指向它。
2. `ssh2`、`ws`、`chokidar` 移进 `devDependencies`，发布包 `dependencies` 为空 —— 装到哪都不再需要联网解析，也不再在安装期尝试编译 `ssh2` 的原生加速模块。
3. ESM 输出有两个坑，都得在 banner 里补：
   - `ws` / `ssh2` 是 CommonJS，会延迟 `require('events')` 这类内置模块，esbuild 无法静态改写，只能在 ESM 里造一个 `createRequire(import.meta.url)`；esbuild 的 `__require` 助手检测到作用域里有真 `require` 就会用它。
   - `ssh2`（及它内联的 emscripten 块）引用 `__dirname` / `__filename`，ESM 里不存在，banner 从 `import.meta.url` 还原。
4. 可选原生模块（`cpu-features`、`bufferutil`、`utf-8-validate`、`*.node`）用 esbuild 插件替换成空对象 —— 它们本来都包在 `try {} catch {}` 里，等价于「这台机器没装可选依赖」。

代价与验证：`lib/server.mjs` 约 980 KiB，包体从 148 KiB 涨到 333 KiB。验证方式是把 `test/ssh.mjs` 跑两遍，第二遍 `--bundle` 直接从 `lib/server.mjs` 拿 `SshPool`（因此 `src/index.js` 多导出了 `SshPool`），对着进程内的 ssh2 服务器完成握手、exec、PTY、TOFU 与错误分类 —— 只有真握手才能证明内联进来的 `ssh2` 没被打坏。实测：

- 解压后的目录**周围没有任何 node_modules**，`import('./package/lib/server.mjs')` 正常导出 `apply/name/inject/SshPool`；
- 用 `link:` 把这个解压目录装进一个带 web-app 的 profile，`dsh` 启动无未激活警告，`hosts.list` 返回真实数据，`hosts.info` 对着真实主机返回 `auth-failed`（说明 bundled ssh2 真的把加密握手走到认证阶段了）。

### 8.10 样式要跟着面板走，而不是跟着模块走（v0.3.2，issue #3）

issue #3 的截图是一整块「裸 HTML」：标签条在、五个视图按钮在、`连接 10.86.55.110` 是 `<h3>` 的默认字号、按钮是凸起的原生外框、输入框没有边框 —— 结构全对，样式一条都没生效。

在最干净的环境里复现不出来。三个环境（0.2.0 + better-sidebar、0.2.1-rc.2 + better-sidebar、0.2.1-rc.2 原生右栏）都是 `{styleTag: true, rules: 212}`，面板样式正常。于是把定位搬到真机：拿用户 `desktop` profile 的整份副本、同一个 0.2.1-rc.2 运行时起服务，仍然正常；最后直接拉起桌面应用本身（`--remote-debugging-port`），`origin` 是 `dsh-app://app`，`#dsh-remote-ssh/panel` 存在、`sheet.cssRules.length === 212`、没有 `sheet === null` 的元素 —— 面板渲染得和原型一致。

所以 CSS 从来不是被打包丢了，也不是被别的插件覆盖了，更不是 CSP 拦了（桌面端主窗口走 `dsh://app` 自定义协议，`serveWebDocument` 只发 `content-type`）。问题在注入方式：

```js
function injectStyles(id, css) {
  if (document.getElementById(id) !== null) return   // ← 先到先得
  ...
}
```

「同 id 已存在就跳过」只在「一次文档、一次求值」时成立。而客户端模块**并不总和文档一起重新求值**：profile 里装着 `client-hmr`，插件在磁盘上被换掉时模块会在同一个文档里被热替换。于是 head 里留着上一版构建的 `<style>`，DOM 是新的那一版 —— 旧表里根本没有 `.rs-phead` / `.rs-hostline` 这些重写后才有类名（可核：`git show af26ac8^:client/styles.js` 里这两个类名出现 0 次），新标记自然一条规则都匹配不上，看起来就是「样式全没了」。重启应用换个 document 就正常，这也解释了为什么干净环境全都好。

修法是两条不依赖具体诱因的规矩：

1. **样式表属于承载面板的那个 document**，不属于模块碰巧被求值时的那个。注入改成 `ensureStyles(doc)`，`Workspace` 用 ref 回调拿 `node.ownerDocument` 再断言一次 —— 弹出/分栏面板是独立 document，有自己的 `<head>`，只往模块级 `document` 注入会漏。
2. **文本不一致就覆盖**。`syncStyle` 比较 `existing.textContent !== css`，不一致就地改写；避免旧表永久遮蔽新面板。

留在 `client/inject-styles.js`，不 import 任何 CSS，于是 `test/styles.mjs` 能在纯 Node 下用假 document 直接跑：注入、幂等（同一节点、不重复追加）、旧表就地刷新（issue #3 的回归）、跨 document 不串味、没有 head 不抛。`apply()` 里的一次性注入保留，作为首屏兜底。

### 8.11 可选原生模块必须「加载即抛」，不能是空对象（v0.3.3，issue #4）

用户点「终端」的一瞬间，整个桌面应用报「应用无法启动或已意外停止」。崩溃日志落在 `%APPDATA%/@deepseek-ai/dsh-desktop/logs/crash-*-host.log`，一行就够：

```
Error: dsh desktop host exited with 1: dsh: fatal uncaught exception:
TypeError: bufferUtil.unmask is not a function
    at module.exports.unmask (lib/server.mjs:146:27)
    at Receiver2.getData (lib/server.mjs:1204:13)
    at Receiver2.startLoop (lib/server.mjs:952:20)
    at Receiver2._write (lib/server.mjs:890:14)
    at Socket.socketOnData ...
```

这是 0.3.1「宿主端也打包」时我埋的雷。当时把三个可选原生模块打桩成 `module.exports = {}`，理由是「它们都包在 try/catch 里，等价于没装」。这个理由对 ssh2 侥幸成立、对 ws 完全不成立：

```js
// ws/lib/buffer-util.js
} else if (!process.env.WS_NO_BUFFER_UTIL) {
  try {
    const bufferUtil = require('bufferutil');
    module.exports.unmask = (buffer, mask) => {
      if (buffer.length < 32) _unmask(buffer, mask);
      else bufferUtil.unmask(buffer, mask);      // ← 这里
    };
  } catch (e) {}                                  // ← require 成功就不进 catch
}
```

ws 判断的是「require 成不成功」，不是「对象长什么样」。空对象让 require 成功，于是 ws **把自己本来正确的纯 JS 实现换成了转发给空壳的包装器**；帧长 ≥32 字节就调 `bufferUtil.unmask`，TypeError，而它抛在 socket 的 `data` 处理器里 —— 未捕获异常，宿主进程直接退出。终端一开，PTY 首屏 banner 轻松超过 32 字节，所以「点终端 = 崩」。

（ssh2 那边是 `cpuInfo = require('cpu-features')()`：空对象一调用就抛，刚好被同一个 try/catch 兜住，纯属运气。）

修法：把打桩改成**模块体直接 throw**。对 `require` 来说这就是「这台机器没有这个可选包」，每个使用方的 `try { require(x) } catch {}` 都会接住并保留自己的可移植路径 —— 这正是可选依赖本来的语义。

为什么测试没抓到：整套测试里**没有一个真 WebSocket**。`test/smoke.mjs` 只校验帧编解码，`test/ssh.mjs` 只走 SSH 通道，`test/e2e-profile.mjs` 需要真 profile。于是补了 `test/ws.mjs`：用**构建产物里的** `WebSocketServer` 加一个真客户端对打，把 ws 分支的每个阈值两侧都压一遍（48 字节服务端 mask、32 字节 unmask、24 字节 UTF-8 校验，再加一条 200 KB 会被拆帧的）。为此 `src/index.js` 多导出 `WebSocketServer`，和 `SshPool` 同一个理由：只有真跑一遍才证明内联进来的副本没坏。用 0.3.1 的打桩构建跑这条测试，报的正是 `bufferUtil.unmask is not a function`。

issue #4 还有后半段：「崩溃后终端只显示 bash 光标，但是无法输入」。那是宿主被拉起后旧 socket 已死、面板仍留着上一个 xterm 屏幕，`onData` 把每个按键都丢进一个已关闭的 socket。现在 `onclose` 会区分「自己关的」（`disposed`）与「被断开的」，后者往屏幕写一行 `[连接已断开]` 并把状态条切成错误态 + 「重连」按钮；`exit` 帧已经解释过原因的（`ended`）不重复报错。

### 8.12 配置错误不能占用连接槽位（v0.3.4，issue #5）

用户新建主机时填了密码，点「测试连接」，回复是「请输入密码」。截图里密码框有三个圆点、认证选的是「密码」、底部状态栏停在「连接中」。

抓包先排掉一半嫌疑：**密码真的发出去了**。

```
POST /remote/app/remote/api/hosts.connect
{"draft":{"id":"host-mw23oqxi-2","host":"10.86.55.110","user":"root","auth":{"type":"password"}},
 "auth":{"password":"Probe#1234"}}
→ {"ok":false,"error":{"code":"bad-password","message":"请输入密码"}}
```

密码在 payload 里，服务端却当它不存在。把范围收窄到池子，一行就能复现：

```js
pool.ensure({ id:'h1', ... auth:{type:'password'} })                      // bad-password
pool.status('h1')                                                          // 'connecting' ← 钉子
pool.ensure({ id:'h1', ... auth:{type:'password', password:'pw'} })       // bad-password（重放）
```

根因在 `ensure()` 与 `#connect()` 的先后顺序：

```js
async ensure(host) {
  ...
  const pending = this.#connect(host)                    // ← 这里可能已经同步拒绝
  this.#records.set(host.id, { status: 'connecting', pending })   // ← 却无条件写成「连接中」
  ...
}

async #connect(host) {
  const options = this.#options(host)   // ← 缺密码在这里抛，在 try/catch 之外
  try { ... } catch (error) { /* 标记 error 的分支永远走不到 */ }
}
```

`#options` 抛的是**配置错误**（缺密码、私钥读不了、没有 ssh-agent），它在 `#connect` 的 try/catch **之前**，所以那条分支里「把记录标成 error」的代码永远不执行；而 `ensure` 已经把记录写成了 `connecting` 并挂上那个**已拒绝的 promise**。此后任何一次 `ensure(host.id)` 都会命中 `existing.status === 'connecting'` 直接返回死 promise —— 于是一个「当时手上没有密码」的后台尝试，把这个主机的所有后续连接都钉死了：密码带上来也没用，回的还是那句话。

谁能触发那次后台尝试：面板一打开就要列文件，主机的 `auth.type` 是 `password`，而密码从不落盘 —— 必然缺密码。这不是异常路径，是**正常路径**。

两处修：

1. **先建 options，再占槽位。** `ensure()` 里 `const options = this.#options(this.#withSecret(host))` 放在写记录之前，配置错误直接抛给调用方、记录一动不动；`#connect(host, options)` 不再自己算 options，也就不会在 try 之外抛。
2. **草稿的 id 按目标派生**（`draft:user@host:port`），且**新建表单不再借用当前主机的 id**。原来 `SettingsPane` 无条件收 `host`，`toRow(form, host?.id)` 把已连接主机的 id 塞进草稿 —— 测试一个全新主机会写进在用主机的连接槽位；而每次随机 id 又会给每次点击留一条不断开的 ssh2 连接。现在按目标派生：重试复用一条，且不可能撞上 `host-…`。

顺势补一个同路径上的安全洞：草稿不带 `fingerprint`，而 `#verifyHost` 对空指纹是「首次接触即钉住」。于是「编辑已有主机 → 测试连接」会把**变过的**主机密钥重新钉上，TOFU 保护静默失效。现在草稿若带真实 id，就从存量行继承指纹（草稿显式给出的仍然优先 —— 那是用户主动重钉）。

回归钉在三处：`test/ssh.mjs` 用进程内 ssh2 服务器证明「缺密码不动槽位、密码一到就连上」，并且失败（`auth-failed`）不是终点、换对密码能重连；`test/api.mjs` 证明草稿 id 稳定、编辑保留指纹。用 v0.3.3 的 `pool.js` 跑 `test/ssh.mjs`，报的正是 `actual: 'connecting', expected: 'disconnected'`。

验证：真机（桌面应用、用户 desktop profile、`link:` 安装）打开面板头部是 `· 未连接`（不再是「正在建立连接…」），填入密码点「测试连接」返回「认证失败：密码被拒绝」—— 密码确实走到了认证阶段。

### 8.13 远端搜索：不要为了看一眼把仓库搬回来（v0.4.0）

文件视图加了一个放大镜。它是**在远端跑**的：有 `rg` 就用 `rg --json`，没有就 `grep -rInZ`，只把命中的行带回来。

不做本地搜索的理由很直接：映射通常只是仓库的一个子目录，而用户在「找那个函数在哪儿」的时候，恰恰不知道它在哪个子目录里。把文件拉回来再搜，既是错的（看不到没映射的部分）也是慢的（一个 node_modules 就够受）。远端本来就有一份完整的树，而且大多数开发机的 `rg` 比任何走 SFTP 的方案快两个数量级。

**为什么不用 `path:line:text`。** 这是最顺手的格式，也是唯一不能用的格式。路径可以带冒号（Windows 盘符、`src/a:b.ts`），正文更可以（`grep` 输出的是整行源码）。一旦解析错，结果不是报错，而是**把 A 文件的命中挂到 B 文件名下**——这种错误没人会怀疑是工具的问题。所以两条通道都选「结构化的那一半」：

- `rg --json`：一行一个 JSON 对象，`match` 事件里带 `path.text`、`line_number`、`lines.text` 和 `submatches[0].start`。
- `grep -rInZ`：`-Z` 在文件名后插一个 NUL，记录变成 `path\0line:text`，路径里的冒号就不再是分隔符。

解析时遇到坏行直接跳过 —— 一条坏记录不该让整次搜索失败。

**截断在远端发生。** 命令尾部是 `| head -n <预算>`，超出预算时 `head` 退出、引擎收到 SIGPIPE（退出码 141）。这一点同时解决两个问题：宿主进程不会因为某个巨型仓库被灌进几百兆字节，而截断点落在**行边界**上，所以每条被解析的记录都是完整的。141 被当作成功，`truncated: true` 一路传到界面。

**裁剪要围绕命中，不是取前 N 个字符。** 第一版是「超过 320 字符就掐头去尾」，测试立刻打脸：压缩过的 JSON 是**一行几兆**，命中在几万字符处，预览里只剩开头的 `{"version":...` —— 用户看到一条结果，却看不到它为什么命中。现在 `rg` 用它给的 `submatches.start` 开窗（命中前留 120 字符），`grep` 没有列信息，就用字面量再 `indexOf` 一次；正则搜索才退回两端裁剪。

**`grep` 的正则必须是 `-E`。** 这个也是自测才发现的：`grep` 默认 BRE，`needle\s+at` 里的 `+` 是**字面加号**，于是用户勾了「正则」反而什么都搜不到。`-F` 与 `-E` 现在互斥地挂在同一个位置，用 `rg` 时行为一致（它本来就是扩展正则）。

**引擎探测与降级。** 每个主机探一次 `command -v rg || command -v grep`，结果缓存；两个都没有就明确报 `no-search-tool`，而不是返回空结果 —— 空结果会被理解成「没有匹配」，然后用户去查自己的关键词。老版本 `rg` 不认 `--json`（退出码 2 且 stderr 提到 `--json`）时切到 `grep` 并记住，不会每次搜索都重试一遍。

**为了让这些东西能真的跑一遍，补了一个假远端**：`scripts/dev-remote.mjs`。它是个 ssh2 服务器，`exec` 走本机 `sh`（所以命令拼接、引号、管道、`head` 全部是真跑的），SFTP 只读映射到一个目录。写它的过程中踩了两个坑，都记在这里：`sftp.handle(reqid, handle)` 必须回**请求 id**，回成自增句柄号会让客户端永远等下去；`child.stdout.pipe(stream)` 会在 stdout 关闭时就把通道 `end()`，之后的 `stream.exit()` 落在死通道上，改成一个显式 exit + end 之后，同一连接上的连续 exec 才稳定。

另有一个语义坑值得记：假远端最初把 SFTP 的 `/` 映射到项目目录，而 `sh` 的 `/` 是盘根 —— 于是「搜索项目」实际扫了整个磁盘（第一批结果里出现了 `/tmp/rsui-chrome/...`）。远端只有**一套**路径空间，假远端也必须只有一套：现在 SFTP 接受与 shell 相同的写法（Windows 上的 `/c/x` 会翻成 `C:/x`），只把访问范围限制在根目录内。

验证：十一轮测试全绿（新增 `test/search.mjs`：两条通道、大小写三档、裁剪窗口、141 截断、rg→grep 降级、真 shell 下的引号/排除/`-E`）；真浏览器（CLI profile + 假远端）输入 `needle` 得到 `4 处 · 3 个文件 · grep · 146ms`，点第 212 行那条，预览打开 `long.ts`、徽标显示「第 212 行」、`scrollTop` 为 `3722`（= `(212-1) × 18.15 − 324/3`，落在目标行的三分之一屏处）。

### 8.14 断点续传：让 part 文件自己就是断点（v0.5.0）

之前用的是 `sftp.fastPut` / `fastGet`：两个函数都能分块并发，所以大文件不会进堆，看起来已经很够了。问题是**它们不记进度**。一次 200 MB 的上传在第 190 MB 断线，重试就从第 0 字节开始 —— 而断线在真实网络里是常态，不是异常。

要续传就得知道「已经到哪儿了」。最省事的做法是记一本进度账，但账本会和现实不一致：进程崩了账本没更新、文件被别处改了账本不知道。所以换了个更笨也更可靠的办法：**part 文件自己就是账本**。

两个方向都是先写同目录的 `<名字>.dsh-part-<大小>-<mtime>`，写完才 rename 成真名。于是：

- 真实文件名下永远不会出现半个文件（rename 是原子的）；
- **part 文件的大小就是断点**，不需要任何额外状态；
- part 名字里的指纹保证了「续的是同一份内容」—— 源文件改了，指纹变了，旧 part 不会被拼接进来。一个前半是旧版本、后半是新版本的二进制文件，比一个明确的失败危险得多。

**顺序写，不是并发写。** 这是这一版最不显然的取舍。并发写不同偏移当然更快，但它会在 part 里留下空洞：`size` 变成「最大偏移 + 长度」，而不是「连续写到了哪里」。那时 stat 出来的大小就不再是可信的断点，续传会把一段空洞当成已完成的字节跳过 —— 生成的文件静默损坏。要支持并发就得再记一张位图，那就又回到「账本和现实不一致」的老问题。所以宁可慢：1 MiB 一块顺序写，局域网实测约 45 MB/s（12 MB 文件补发 8 MB 用 175 ms），换来断点永远可信。

**为什么不在每次上传前扫一遍残留。** 想找到「别人的 part」就得 `readdir` 目标目录，而一次推送 1000 个文件就是 1000 次目录读取。所以清理做成显式动作：`transfer.cleanParts`（同步面板每个映射卡片上的「清理残留」），它只删 part 文件，返回删了多少个、多少字节。残留只在两种情况下产生 —— 中断、源文件改过 —— 频率低、体积可控。

**假远端也得能写。** 上一版 `dev-remote.mjs` 是只读的（文件浏览够了），这一版要验上传就得补 `WRITE`/`MKDIR`/`REMOVE`/`RMDIR`/`RENAME`。补的过程中踩到一个安静的错误：`MKDIR` 原本把「目录已存在」报成 `PERMISSION_DENIED`，而客户端把权限错误当致命错误 —— 于是「上传到已存在的目录」直接失败。现在先 `existsSync` 再决定：已存在 → `FAILURE`（客户端会忽略），其余 → `FAILURE`，从不报权限。另一个是 `open` 的 flags 映射：`CREAT|TRUNC` 被当成 `r+`，创建新 part 时 `ENOENT`。

验证：`test/transfer.mjs` 用内存 SFTP 桩钉住五件事 —— 多块文件字节精确、中断后 part 大小等于已传字节、续传只补发剩余（断言第二次的第一块 offset）、源文件变化时 `resumedFrom` 是 0、目录遍历跳过 part。真实 SFTP（`scripts/dev-remote.mjs`）上跑了 12 MB：4 MiB 处中断 → part 恰好 4194304 B → 续传 175 ms → sha256 与本地一致；反方向同样，下载中断后从 4 MiB 续上，最终一致。

### 8.15 三种转发：难点不在协议，在「谁监听」（v0.6.0）

`-L` 从 0.2.0 就在了。补 `-D` 和 `-R` 时最花时间的不是 SOCKS5 协议，也不是 `forwarded-tcpip` 通道 —— 这两块都有清晰文档 —— 而是三件事：

**一、规则模型必须换轴。** 旧规则是 `{localPort, remoteHost, remotePort, bind}`：`local` 永远指本机、`remote` 永远指服务器。这只对 `-L` 成立。`-R` 的监听端口在服务器上、目标端口在本机，同一组字段立刻互相矛盾，只能在文档里写「对 `-R` 而言 `localPort` 其实是目标」，然后每个读代码的人都得先背一遍这张表。所以规则改成 `{kind, listen, target}`：**按角色命名，而不是按方位命名**。哪一端在本机由 `kind` 决定（`listenSide(kind)`），字段本身永远只说「谁是监听、谁是目标」。迁移在 `Store.load()` 里做一次：0.5.x 落盘的规则没有 `kind`，一律是 `-L`，`normalizeRule` 按此解释，下次保存就收敛成新形状。

**二、`-R` 的监听端口会随连接消失。** `-L`/`-D` 的监听器在本机，连接断了它还在，下一次入站连接触发惰性重连即可（§8.6 第 2 条）。`-R` 反过来：监听器在**服务器**上，是那条连接的一部分，断线即销毁。所以在池子里记「规则已监听」是个谎。处理办法是把反向转发登记放进 `SshPool` 而不是 `ForwardManager` —— 只有池子知道什么时候有新的 client ready，也只有它能在重连后重新 `forwardIn` 一遍。面板读的是登记里的 `granted`/`held`，端口没申请回来时明确显示「服务器上的端口暂时不存在」，而不是沿用上一次的 `listening`。

**三、失败的归属不一样。** `-L`/`-R` 只有一个用户配的目标，失败是**规则**的问题，该进面板；`-D` 的目标由客户端每次指定，一个目标连不上说明不了代理坏了 —— 回一个 SOCKS 错误码就够了，规则保持健康。同理，一个把 HTTP 请求发到 SOCKS 端口的浏览器探测不算「启动失败」。这条区分写在 `#serveSocks` 的注释里，因为它是一眼看不出来的正确性。

再就是几个安静的坑：

- **SOCKS5 的回复必须在通道打开之后写。** 先回 `0x00` 再发现连不上，客户端会把它当成「连上了然后立刻被关」，报错位置完全错。代价是握手期间要等一次 `direct-tcpip`，但那本来也是这个代理的全部工作。
- **客户端可以把首包和握手一起发来。** 握手解析器会把请求之后多出来的字节吞进自己的 buffer，直接丢弃就等于损坏每一次「握手后立刻发数据」的连接（HTTP 客户端全都这样）。所以解析结果带一个 `rest`，接上通道后原样写进去。
- **`BIND`/`UDP` 要明确拒绝。** 回 `0x07`，不能不理：代理里一个等不到回复的客户端会被当成网络问题排查半天。
- **`0.0.0.0:8080` 和 `127.0.0.1:8080` 是冲突的。** 系统本来就不会同时给你这两个（通配地址覆盖具体地址），旧的判重按字符串比会放过它，然后在 `listen` 时报一句看不懂的 `EADDRINUSE`。现在按「同端口 + 其中一个是通配」判冲突。反过来，`-L` 和 `-R` 用同一个端口号**不算**冲突 —— 它们监听在不同机器上。
- **假远端要会说 `tcpip-forward`。** 测试里的 ssh2 `Server` 收到全局请求自己 `listen`，入站时用 `client.forwardOut(boundAddr, boundPort, peerAddr, peerPort)` 推通道。参数顺序踩过一次：前两个是**服务器绑定的那一对**，客户端拿它去匹配自己的登记表；写反了每个通道都会被客户端拒绝，症状是「连接建立后立刻关闭」，看起来像业务 bug。

验证：`test/socks5.mjs` 钉协议层（拆包、管道化、三种地址、`BIND`、0 端口、空域名、非 SOCKS、超时、错误码），`test/forward.mjs` 三种形状都跑真实 TCP 往返，其中 `-R` 会故意把底层连接掐掉，验证重连后端口被重新申请回来、隧道自动恢复。界面在真实浏览器里点过一遍：`-D` 的 SOCKS 端口收到 `echo:via-socks`，`-L` 收到 `echo:via-local`，`-R` 收到 `echo:via-reverse`。
