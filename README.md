# dsh-remote-ssh

DSH（DeepSeek Harness）的远程 SSH 插件：在侧边栏里看远端文件系统、开远端终端，本地改动自动上传、远端文件可下载，并与 `dsh-better-sidebar` 联动。

当前状态：**B 版已实现并通过端到端验证**（本地镜像 + 旁挂远端通道，本地为真相）。

## 目录

```
src/               宿主端：HTTP API、WebSocket 终端、SSH 连接池、文件/传输/同步
client/            浏览器端：三个侧边栏标签页（文件 / 终端 / 同步）
lib/client.js      构建产物（esbuild 打包，由宿主按 /plugins/... 提供）
docs/design.md     架构取舍、平台发现、问题清单、里程碑
ui/prototype.html  UI 原型（单文件，浏览器直接打开，7 个状态可切换）
test/              四组测试（见下）
scripts/           对着真实服务器跑的验收脚本
```

## 先看原型

双击 `ui/prototype.html`。顶栏可切换 7 个界面状态：连接页 / 连接中 / 文件 / 终端 / 同步 / 设置 / 错误。
也支持 `?view=terminal`、`?view=sync` 等直达链接。

## 核心判断（详见 docs/design.md）

1. 这不是一个 SSH 客户端，而是「本地工作区的远端影子」——因为 agent 和 better-sidebar 都在本地工作。
2. DSH 有 `ctx.fs` / `ctx.subprocess` 执行世界抽象，理论上可以把整个 harness 搬到远端；但 better-sidebar 绕过 `ctx.fs` 直读本地（grep 它的 `src/` 里没有任何 `ctx.fs` / `ctx.subprocess`），两条路线混用会产生 split-brain。
3. 因此 v0.x 走「本地镜像 + 旁挂远端通道」，执行世界替换作为 v1.0 独立 profile 实验。

## 装到 profile 里

```bash
# 1. 链接到某个 profile（Windows 用目录联接，pnpm link 在 profile 根目录会失败）
# 2. 在该 profile 的 cordis.patch.yml 追加：
```

```yaml
- insert:
    - id: dsh-remote-ssh
      name: "dsh-remote-ssh"
```

```bash
# 3. 启动（注意 app 参数直接跟在后面，不要写 `web`）
dsh --profile <name> --no-open --port 4987
```

插件自己在 `~/.dsh/storages/dsh-remote-ssh/state.json` 存主机与映射。**密码和口令永不落盘**，只存在浏览器内存里，每次连接现取。

## 终端与 tmux

远端有 tmux 时自动执行 `tmux new -A -s dsh-<host>`：刷新页面、IDE 重启、网络抖动之后都重新接回同一个 shell。
远端没有 tmux 时退回普通登录 shell，并在终端上方给出明确警告（「刷新页面或断线后，本次会话的进程会一起结束」），而不是假装一切正常。

两个分支都有测试覆盖（`test/e2e-profile.mjs`），包括 tmux 存在时实际下发的 argv 是 `tmux new -A -s dsh-xxx`。

## 路径映射与同步语义

- **默认单向**：本地 → 远端（agent 改的文件自动推上去）。按映射开双向后，远端变更才会被下载。
- **本地是真相**：冲突判定 = 本地改过 **且** 远端 mtime 相对基线漂移超过 2s；冲突只报告，不自动裁决，由 UI 给「保留本地 / 保留远端 / 忽略」。
- **删除不传播**：本地删除只在队列里记一笔，绝不会在远端 `rm`。
- 写入用临时文件 + rename 落地，避免 agent 读到半个文件；远端可执行位按本地 mode 推（Windows 上靠 `modeTemplate` 补回来）。

## 验证

```bash
npm run build        # 构建 lib/client.js
npm test             # 三组 Node 测试：API/路由、SSH 传输、文件层
```

浏览器产物检查（在真实 Chrome 里加载 bundle，验证三个标签页注册、重复挂载幂等、卸载后清空、无 better-sidebar 时静默降级）：

```bash
chrome --headless=new --dump-dom test/bundle-check.html
```

对着真实服务器验收（连接、环境探测、tmux、UTF-8 读写、上传下载字节一致、PTY 回显）：

```bash
node scripts/check-ssh.mjs
```

在真实 DSH profile 里验收（需要先起一个 profile 并拿到 cookie jar）：

```bash
RS_ORIGIN=http://127.0.0.1:4987 RS_COOKIE_JAR=/path/to/jar node test/e2e-profile.mjs
```

## 环境

- DSH `0.2.0-rc.2`
- `dsh-better-sidebar` `0.28.0`（peer，optional）
- Node ≥ 20

注意：`dsh-better-sidebar@0.28.0` 的 peer 要求是 `^0.2.1-rc.1`，在 `0.2.0-rc.2` 上 DSH 会**跳过**这个 bundle，除非显式授权版本豁免（`dsh plugin allow-version`）。本插件不依赖它启动：服务不在时客户端不注册标签页、不报错；服务在时按下面的契约注册。

| 项 | 契约 |
| --- | --- |
| 注册 | `ctx.inject(['betterSidebar'], svc => svc.registerTab(descriptor))`，返回 disposer |
| 描述符 | `id / title / description / icon / order / component`；`title` 与 `icon` 可以是函数（插件内部用 `textOf` / `iconOf` 解析，`icon(size)`） |
| 重复 id | 原生实现会 `throw`，所以注册前用 `getTab(id)` 跳过（HMR 重挂不炸） |
| 组件 props | `ctx, store, scope, tab, visible, expanded, revealed, …`，面板用 `scope.sessionId` 与 `visible` |
