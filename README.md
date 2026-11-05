# dsh-remote-ssh

DSH（DeepSeek Harness）的远程 SSH 插件：在侧边栏里看远端文件系统、开远端终端、把远端服务映射到本机，本地改动自动上传、远端文件可下载，并与 `dsh-better-sidebar` 联动。

当前状态：**B 版已实现并通过端到端验证**（本地镜像 + 旁挂远端通道，本地为真相）。`v0.1.0` 覆盖文件/终端/同步，`v0.2.1` 增加不依赖 better-sidebar 的原生入口，`v0.3.0` 把界面重做成与 `ui/prototype.html` 一致，并补上密码输入与主机切换。

## 两个入口（better-sidebar 是可选的）

| 装了什么 | 出现在哪 | 怎么打开 |
| --- | --- | --- |
| 有 `dsh-better-sidebar` | better-sidebar 的侧栏，**一个**名为「远程 SSH」的标签页 | 侧栏里点「远程 SSH」 |
| 没有 / 停用了 `dsh-better-sidebar` | DSH **自带的右侧边栏**，同一个「远程 SSH」面板 | 会话头部右上角的服务器图标按钮 |

无论走哪条路，面板都是同一个组件：主机头 + 一条标签条（文件 / 终端 / 同步 / 转发 / 设置）+ 状态栏。早先版本在 better-sidebar 里注册了四个标签页，把侧栏挤得很满，`v0.3.0` 起统一成一个（见 issue #1）。

两条路径互斥：如果 better-sidebar 在启动后才激活，插件会把原生入口撤掉、换成同一个标签页，不会同时出现两个入口。

## 目录

```
src/               宿主端：HTTP API、WebSocket 终端、SSH 连接池、文件/传输/同步、端口转发
client/            浏览器端：一个 Workspace 面板 + 五个视图 + 两个入口（better-sidebar 标签页 / 原生右侧边栏）
lib/client.js      构建产物：客户端 bundle（esbuild 打包，由宿主按插件名提供）
lib/server.mjs     构建产物：宿主端 bundle（ssh2 / ws / chokidar 全打进来，包里零运行期依赖）
docs/design.md     架构取舍、平台发现、问题清单、里程碑
ui/prototype.html  UI 原型（单文件，浏览器直接打开，可切深色）——界面以它为准
test/              六组测试（见下）
scripts/           对着真实服务器跑的验收脚本
```

## 先看原型

双击 `ui/prototype.html`。顶栏可切换界面状态：连接页 / 连接中 / 文件 / 终端 / 同步 / 转发 / 设置 / 错误。
也支持 `?view=terminal`、`?view=sync` 等直达链接。

面板按原型的 424px 设计，宽度跟着右侧栏走；原型里的深色版本通过 `light-dark()` 复用同一套 token，自动跟随 DSH 的主题。

## 核心判断（详见 docs/design.md）

1. 这不是一个 SSH 客户端，而是「本地工作区的远端影子」——因为 agent 和 better-sidebar 都在本地工作。
2. DSH 有 `ctx.fs` / `ctx.subprocess` 执行世界抽象，理论上可以把整个 harness 搬到远端；但 better-sidebar 绕过 `ctx.fs` 直读本地（grep 它的 `src/` 里没有任何 `ctx.fs` / `ctx.subprocess`），两条路线混用会产生 split-brain。
3. 因此 v0.x 走「本地镜像 + 旁挂远端通道」，执行世界替换作为 v1.0 独立 profile 实验。

## 装到 profile 里

推荐用发布包安装（一条命令，DSH 自己会把它写进 `dsh.profile.bundles`）：

```bash
npm run pack:rel     # 生成 dist/dsh-remote-ssh-<版本>.tgz
dsh plugin --profile <profile> add -w "C:/绝对路径/dsh-remote-ssh-0.3.1.tgz"
```

`-w` 不能省：profile 里有 `pnpm-workspace.yaml`，pnpm 认为根是 workspace root，不带 `-w` 会报 `ERR_PNPM_ADDING_TO_ROOT`。

装完 `package.json` 会变成：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-remote-ssh"] } },
"dependencies": { "dsh-remote-ssh": "file:C:/.../dsh-remote-ssh-0.3.1.tgz" }
```

**不要解压 tgz 后指向解压出来的目录。** pnpm 会把本地目录写成 `link:`，而链接进来的目录不会安装它自己的依赖 —— 一旦插件还有 `dependencies`，宿主端第一次 `import` 就会 `ERR_MODULE_NOT_FOUND`，整个插件停用，界面上只留一句「启用失败」。

`0.3.1` 起这条坑已经填了：发布包里**没有任何运行期依赖**。`ssh2`、`ws`、`chokidar` 全部被 esbuild 打进 `lib/server.mjs`（约 980 KiB），装到哪都一样能跑，`link:` 也行。所以包里 `dependencies` 是空的，`ssh2` 也不再在安装期尝试编译原生模块。

然后启动（app 参数直接跟在后面，不要写 `web`）：

```bash
dsh --profile <name> --no-open --port 4987
```

`desktop` profile 由桌面应用独占，CLI 会拒绝（`profile "desktop" is managed exclusively by the Electron application`）。这种 profile 请在应用内的插件页面安装，或手工改 `package.json` 的 `bundles` 与 `cordis.patch.yml` 后重启应用。

开发期想直连源码目录（改代码立即生效，但要自己保证 `lib/client.js` 已构建）时，也可以只在 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: dsh-remote-ssh
      name: "dsh-remote-ssh"
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

## 连接、密码与主机切换

未连上主机时，文件和终端两个视图会先显示一个连接门（`client/connect-view.jsx`），而不是一片空白。门上有：

- **主机列表**：点一行即切主机；当前主机用强调色描边。
- **密码框**：认证方式是密码的主机，密码直接在这里输 —— `type="password"`，回车即连。值只进内存里的 `secretStore`，**不写磁盘、不进日志、不随状态持久化**。
- **「改用密码」**：密钥认证失败（`auth-failed` / `key-invalid`）时一键切换到密码，不用先去设置页改认证方式。
- **明确的失败原因**：`auth-failed` / `bad-password` / `no-agent` / `timeout` / `refused` / `dns-failed` / `host-key-changed` 各有中文标题，原始 stderr 放在错误框里。

主机切换的第二个入口是面板标题栏的主机名：点一下弹出主机菜单（在线状态徽标 + 新建 / 管理），不用切到别的视图。

主题：面板不给自己的调色板之外的颜色 —— 亮/暗两套色值直接取自 `ui/prototype.html`，用 `light-dark()` 绑到宿主的 `color-scheme` 上。没有用 `--dsw-alias-*`：当前构建里品牌色是近黑（`#0f1115`）、边框是 4% 黑，套上去会把原型的蓝色强调和所有分隔线抹平。

## 验证

```bash
npm test             # 先自动 build（两个 bundle），再跑七轮 Node 测试
```

`npm test` 有 `pretest` 钩子，会先重建两个 bundle —— 否则渲染测试可能跑在旧产物上，改了代码却仍报绿。

| 套件 | 覆盖 |
| --- | --- |
| `test/smoke.mjs` | 路由、主机、映射、转发规则的增删与校验、落盘、排除规则、终端帧 |
| `test/ssh.mjs` | 握手、认证、exec、PTY、TOFU、错误分类、连接复用。跑两遍：一遍对 `src/`，一遍对 `lib/server.mjs`（`--bundle`），证明内联进来的 `ssh2` 还能握手 |
| `test/files.mjs` | 列表、文本守卫、原子写、陈旧检测、目录操作 |
| `test/forward.mjs` | 真实 TCP 往返穿透 `direct-tcpip`、字节统计、端口占用、停止后拒绝、autoStart、落盘无密码 |
| `test/render.mjs` | 用真实 React（`react-dom/server`）渲染五个视图 + 连接门四态 + 原生工作区，并断言密码框存在（issue #2），捕捉只在渲染时炸的错 |
| `test/native.mjs` | 两个入口的取舍：有 better-sidebar 时**一个**标签页、没有时原生类型/面板/头部按钮、后激活时的交接、卸载后无残留 |

浏览器产物检查（在真实 Chrome 里加载 bundle，验证标签页注册、order 46、重复挂载幂等、卸载后清空）：

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
- **新功能一律从 `main` 切 `feat/<名字>`**，做完 `--no-ff` 合回 `main`。**分支合完保留，不要删**——后面回看某个功能的独立历史、或者在旧功能上接着改都要用到它。名字用短横线：`feat/port-forward`、`feat/remote-search`、`feat/resume-transfer`。
- 提交信息用 conventional 前缀：`feat:` 新功能、`fix:` 修缺陷、`docs:` 文档、`test:` 测试、`chore:` 杂项。

```bash
git switch -c feat/remote-search             # 开工
git commit -am "feat: 远端 rg 搜索"
git switch main && git merge --no-ff feat/remote-search
git tag -a v0.3.0 -m "v0.3.0 —— 远端搜索"      # 发版
```

### 发布包

```bash
npm run pack:rel      # 先跑 build，再 npm pack 到 dist/
```

`prepack` 钩子保证打包前一定重建 `lib/client.js`，所以包里不会出现旧产物。包内只含运行期需要的东西：`src/`、`lib/client.js`、`cordis.patch.yml`、`README.md`、`package.json`（18 个文件，约 140 KB）。`dist/` 不进版本库——它可以从任何一个标签重新生成。

`test/`、`scripts/`、`docs/` 不进包，所以装到别处后跑不了 `npm test`；要在包装好的产物上验证，就在源码目录里跑。

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

注意：`dsh-better-sidebar@0.28.0` 的 peer 要求是 `^0.2.1-rc.1`，在 `0.2.0-rc.2` 上 DSH 会**跳过**这个 bundle。跳过不影响本插件：它会改用原生右侧边栏 + 会话头部按钮作为入口。想继续用 better-sidebar 的两个选择：

1. **降到 `0.26.1`**（peer 是 `^0.2.0-rc.2`，天然匹配，不需要任何豁免，`registerTab` 契约一致）：`dsh plugin --profile <name> add -w dsh-better-sidebar@0.26.1`。
2. 或给 `0.28.0` 授权豁免：

```bash
dsh plugin --profile <name> version-exemptions      # 看当前被拦的包与运行时版本
dsh plugin --profile <name> allow-version dsh-better-sidebar@0.28.0 \
  --dsh-version 0.2.0-rc.2 --accept-risk
```

豁免写在 `<profile>/compatibility.json`，只对「这个包的这个版本 + 这个运行时版本」生效，升级任一侧都要重新授权。`desktop` profile 由应用独占，这条命令要在应用内的插件页面执行。

本插件不依赖 better-sidebar 启动：服务不在时走原生入口（见上文「两个入口」）；服务在时按下面的契约注册。

| 项        | 契约                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 注册       | `ctx.inject(['betterSidebar'], svc => svc.registerTab(descriptor))`，返回 disposer                                         |
| 描述符      | `id / title / description / icon / order / component`；`title` 与 `icon` 可以是函数（插件内部用 `textOf` / `iconOf` 解析，`icon(size)`） |
| 重复 id    | 原生实现会 `throw`，所以注册前用 `getTab(id)` 跳过（HMR 重挂不炸）                                                                          |
| 组件 props | `ctx, store, scope, tab, visible, expanded, revealed, …`，面板用 `scope.sessionId` 与 `visible`                              |

原生入口用的是 DSH 自带的那套（`dsh-web-app` bundle 里的 `ui-sidebar-right`），不依赖任何第三方插件：

| 项 | 契约 |
| --- | --- |
| 类型 | `sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide })`，`id` 与 `kind` 都是 `dsh-remote-ssh` |
| 面板 | `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: id, inject: (sessionId) => props }, Component))` |
| 入口按钮 | `conversation.session.header.utilities` 槽（list 槽，用 `id`），点击调 `sidebarRight.openTab('dsh-remote-ssh')` |
| 读取服务 | 客户端 ctx 是 Proxy，**未 `inject` 的服务读属性会抛** `cannot get property "x" without inject`；一律用 `ctx.get(name)` |
| 路由前缀 | HTTP 用 `document.baseURI`（反代前缀跟着走）；桌面壳页面是 `dsh-app://`，WebSocket 必须改用 `__DSH_TRANSPORT__.streamBaseUrl` |
