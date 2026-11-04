# dsh-remote-ssh

DSH（DeepSeek Harness）的远程 SSH 插件：在侧边栏里看远端文件系统、开远端终端、把远端服务映射到本机，本地改动自动上传、远端文件可下载，并与 `dsh-better-sidebar` 联动。

当前状态：**B 版已实现并通过端到端验证**（本地镜像 + 旁挂远端通道，本地为真相）。`v0.1.0` 覆盖文件/终端/同步，`feat/port-forward` 增加端口转发。

## 目录

```
src/               宿主端：HTTP API、WebSocket 终端、SSH 连接池、文件/传输/同步、端口转发
client/            浏览器端：四个侧边栏标签页（文件 / 终端 / 同步 / 转发）
lib/client.js      构建产物（esbuild 打包，由宿主按 /plugins/... 提供）
docs/design.md     架构取舍、平台发现、问题清单、里程碑
ui/prototype.html  UI 原型（单文件，浏览器直接打开，7 个状态可切换）
test/              六组测试（见下）
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

## 端口转发（ssh -L）

远端只监听 `127.0.0.1` 的服务 —— Redis、Postgres、前端 dev server —— 用「转发」标签页映射到本机：本地端口 `6379` → 远端 `127.0.0.1:6379`，然后本地照常连 `localhost:6379`。等价于：

```bash
ssh -L 6379:127.0.0.1:6379 me@server
```

| 项 | 行为 |
| --- | --- |
| 绑定地址 | 默认 `127.0.0.1`；选 `0.0.0.0` 会在面板顶部标红 —— 那等于把远端服务暴露给整个局域网 |
| 启动时机 | 默认随主机连接自动启动；也可以关掉改成手动 |
| 连接复用 | 走主机已建立的 SSH 连接（`direct-tcpip` 通道），不需要二次认证 |
| 掉线恢复 | 监听器不随连接断开而销毁：下一条入站连接会惰性重连。为此凭据只留在进程内存里，显式断开即清除，永不落盘 |
| 端口冲突 | 保存时按「绑定地址 + 本地端口」判重；真正 listen 失败会明确说「本地端口已被占用」而不是笼统的失败 |
| 停止 | 停止规则或断开主机时关闭监听，并掐断已建立的隧道 |

远端服务拒绝连接（服务没起来）和 SSH 层失败是两种错误码（`target-refused` / `transport`），面板能分别提示。

## 路径映射与同步语义

- **默认单向**：本地 → 远端（agent 改的文件自动推上去）。按映射开双向后，远端变更才会被下载。
- **本地是真相**：冲突判定 = 本地改过 **且** 远端 mtime 相对基线漂移超过 2s；冲突只报告，不自动裁决，由 UI 给「保留本地 / 保留远端 / 忽略」。
- **删除不传播**：本地删除只在队列里记一笔，绝不会在远端 `rm`。
- 写入用临时文件 + rename 落地，避免 agent 读到半个文件；远端可执行位按本地 mode 推（Windows 上靠 `modeTemplate` 补回来）。

## 验证

```bash
npm test             # 先自动 build，再跑五组 Node 测试
```

`npm test` 有 `pretest` 钩子，会先重建 `lib/client.js` —— 否则渲染测试可能跑在旧产物上，改了代码却仍报绿。

| 套件 | 覆盖 |
| --- | --- |
| `test/smoke.mjs` | 路由、主机、映射、转发规则的增删与校验、落盘、排除规则、终端帧 |
| `test/ssh.mjs` | 握手、认证、exec、PTY、TOFU、错误分类、连接复用 |
| `test/files.mjs` | 列表、文本守卫、原子写、陈旧检测、目录操作 |
| `test/forward.mjs` | 真实 TCP 往返穿透 `direct-tcpip`、字节统计、端口占用、停止后拒绝、autoStart、落盘无密码 |
| `test/render.mjs` | 用真实 React（`react-dom/server`）渲染四个面板，捕捉只在渲染时炸的错 |

浏览器产物检查（在真实 Chrome 里加载 bundle，验证四个标签页注册、顺序、重复挂载幂等、卸载后清空、无 better-sidebar 时静默降级）：

```bash
chrome --headless=new --dump-dom test/bundle-check.html
```

对着真实服务器验收（连接、环境探测、tmux、UTF-8 读写、上传下载字节一致、PTY 回显）：

```bash
node scripts/check-ssh.mjs
```

在真实 DSH profile 里验收（需要先起一个 profile 并拿到 cookie jar）。它会走完整网关验证：路由挂载、cookie 准入、两条终端分支、PTY 往返、以及经 HTTP 下发的端口转发真实穿透一次：

```bash
RS_ORIGIN=http://127.0.0.1:4987 RS_COOKIE_JAR=/path/to/jar node test/e2e-profile.mjs
```

## 版本与分支约定

- **`main` 永远是可用版本**。每次发版打附注标签（`v0.1.0`、`v0.2.0`…），标签说明里写清两件事：凭什么算可用、还差什么。用 `git tag -n99 -l` 或 `git show v0.1.0` 查看。
- **新功能一律从 `main` 切 `feat/<名字>`**，做完合回 `main` 再删分支。名字用短横线：`feat/port-forward`、`feat/remote-search`、`feat/resume-transfer`。
- 提交信息用 conventional 前缀：`feat:` 新功能、`fix:` 修缺陷、`docs:` 文档、`test:` 测试、`chore:` 杂项。

```bash
git switch -c feat/port-forward              # 开工
git commit -am "feat: 端口转发 -L 的规则与生命周期"
git switch main && git merge --no-ff feat/port-forward
git tag -a v0.2.0 -m "v0.2.0 —— 支持本地端口转发"   # 发版
```

### 推到 GitHub

仓库目前只做了本地初始化，没有配远程。联网后执行：

```bash
git remote add origin git@github.com:<你的账号>/dsh-remote-ssh.git
git push -u origin main
git push --tags          # 标签不会跟着 main 自动推，必须单独推
```

## 环境

- DSH `0.2.0-rc.2`
- `dsh-better-sidebar` `0.28.0`（peer，optional）
- Node ≥ 20

注意：`dsh-better-sidebar@0.28.0` 的 peer 要求是 `^0.2.1-rc.1`，在 `0.2.0-rc.2` 上 DSH 会**跳过**这个 bundle，除非显式授权版本豁免（`dsh plugin allow-version`）。本插件不依赖它启动：服务不在时客户端不注册标签页、不报错；服务在时按下面的契约注册。

| 项        | 契约                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 注册       | `ctx.inject(['betterSidebar'], svc => svc.registerTab(descriptor))`，返回 disposer                                         |
| 描述符      | `id / title / description / icon / order / component`；`title` 与 `icon` 可以是函数（插件内部用 `textOf` / `iconOf` 解析，`icon(size)`） |
| 重复 id    | 原生实现会 `throw`，所以注册前用 `getTab(id)` 跳过（HMR 重挂不炸）                                                                          |
| 组件 props | `ctx, store, scope, tab, visible, expanded, revealed, …`，面板用 `scope.sessionId` 与 `visible`                              |
