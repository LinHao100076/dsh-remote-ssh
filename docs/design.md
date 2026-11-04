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

`ui/prototype.html`（单文件，双击可开，可切深色）：

- 顶部状态切换：连接页 / 连接中 / 文件 / 终端 / 同步 / 设置 / 错误 —— 七个状态都是真实会出现的界面，方便评审时逐条挑刺；
- 文件页：路径面包屑 + 懒加载树 + git 状态徽标 + "待上传"箭头 + 悬停操作（下载/上传）+ 底部文件预览条（含"在 better-sidebar 编辑器打开"这个联动入口）；
- 终端页：多 tab + 会话信息条 + 真实可输入的提示符（回车有回显演示）+ 快捷键提示；
- 同步页：映射卡片 / 策略分段控件 / 冲突卡片（三选一）/ 传输队列（带进度）/ 安全开关；
- 设置页：连接表单 + 映射表 + 行为开关 + 保存/测试；
- 底部状态栏固定显示：连接状态 · 映射数 · 队列数 · better-sidebar 版本（联动可见性）。

设计取舍：宽度按 424px 真实右侧栏做，不做"大屏才好看"的布局；所有信息密度按"开发者一天要看 200 次"来压，不放大卡片和留白。

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
| 客户端三个标签页 | `client/index.js`、`client/*-view.js` |

### 8.2 三个踩过的坑

1. **`ctx` 是 Proxy，不是对象**。访问未在 `inject` 里声明的服务会抛 `cannot get property "x" without inject`。我在 `system.ping` 里读了 `ctx.pluginVersion`，单测用的假 ctx 是普通对象所以全绿，真 profile 里直接 500。修法：版本从插件自身传入（`buildApi({ version })`），并且把单测的假 ctx 也换成同样会抛错的 Proxy —— 这类 bug 只有让测试环境同样严格才防得住。

2. **`registerTab` 对重复 id 会 `throw`**（`[dsh-better-sidebar] tab type "x" already registered`），且它的返回值才是 disposer。HMR 在旧 effect 销毁前重跑 `apply` 就会炸掉整个面板。修法：注册前用 `service.getTab(id)` 判断，已存在就跳过；`ctx.effect(() => service.registerTab(...))` 保留返回的 disposer。

3. **测试会悄悄跑在旧产物上。** 客户端代码写错时 `build.mjs` 失败，但 `npm test` 照样读上一次的 `lib/client.js` 全绿 —— 改完代码却看到绿灯，比红灯危险得多。修法：`package.json` 加 `"pretest": "node build.mjs"`，npm 会在 `test` 前自动跑，构建失败即中止。

### 8.3 tmux 判定位置

判定放在 `attachTerminal` 里、每条连接现算，而不是保存主机时算一次 —— 远端可能中途装上 tmux，也可能换了台机器。探测和终端共用同一次 `files.info()` 执行（`uname` / `$SHELL` / `$HOME` / `command -v tmux`），一次往返拿到全部事实。

### 8.4 验证覆盖

| 测试 | 覆盖 | 命令 |
|---|---|---|
| `test/smoke.mjs` | 路由注册、主机增删、映射归一化、落盘无密码、排除规则、终端帧、未声明服务访问会抛错 | `node test/smoke.mjs` |
| `test/ssh.mjs` | 握手、密码认证、exec、PTY、TOFU 记录、改指纹报 `host-key-changed`、错密码报 `auth-failed`、连接复用 | `node test/ssh.mjs` |
| `test/files.mjs` | 列表排序、二进制/超大/陈旧守卫、原子写不留临时文件、mkdir 递归、rename、递归删除 | `node test/files.mjs` |
| `test/forward.mjs` | 真实 TCP 往返穿过 `direct-tcpip`、字节统计、同端口判重、端口被占、停止后拒绝连接、autoStart 语义、规则持久化无密码 | `node test/forward.mjs` |
| `test/render.mjs` | 用真实 React `renderToString` 渲染四个面板，捕捉只在渲染期暴露的错误 | `node test/render.mjs` |
| `test/bundle-check.html` | 真实浏览器加载 bundle：三个标签页、顺序 46/47/48、title/icon 函数解析、重复挂载幂等、卸载后清空、无 better-sidebar 时静默 | `chrome --headless=new --dump-dom …` |
| `test/e2e-profile.mjs` | 真实 DSH profile 内：路由挂载、cookie 准入、两条终端分支、PTY 往返、resize 不断连 | 见 README |
| `scripts/check-ssh.mjs` | 真实服务器：连接、UTF-8 读写、上传下载字节一致 | `node scripts/check-ssh.mjs` |

### 8.5 还没做的（有意留白）

- **执行世界替换（A 路线）**：`ctx.fs` / `ctx.subprocess` 换成远端实现，让 agent 全程在远端跑。前提是先让 better-sidebar 也不再直读本地，否则 split-brain。
- **远端搜索**：希望走远端 `rg` 而不是拉文件回来本地搜。
- **断点续传**：大文件目前是整包 `fastPut`，中断即重来。
- **端口转发的进阶能力**：`socks5` 动态转发、`-R` 反向转发都没做；目前只有 `-L`。

### 8.6 端口转发的三个取舍

1. **默认绑回环，公开绑定要显式选且会被标红。** 把数据库端口转到 `0.0.0.0` 等于把它接到咖啡厅的 Wi-Fi 上；默认值必须是安全的那个，危险动作必须多一次选择，并且在界面上一直可见（`exposed` 字段一路传到面板顶部横幅）。

2. **监听器比连接活得久。** SSH 掉线时不拆监听器 —— 池子会在下一条入站连接到达时惰性重连，所以用户的浏览器刷新两次不至于让隧道永久失效。代价是池子要在内存里留一份凭据（`#secrets`）：只存在于进程内，显式 `close()` 或插件卸载即清除，且状态文件里永远只有 `auth.type`。

3. **错误要分清「远端服务没起」和「SSH 断了」。** 前者是 `target-refused`（服务本身的问题，改远端），后者是传输层错误（改网络或认证）。混成一个「转发失败」，用户就不知道该去修哪一头。

