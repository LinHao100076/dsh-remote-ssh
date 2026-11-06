# 参与贡献

这个项目按「**现象 → 复现 → 修 → 用测试钉住**」的节奏走。任何一环缺失，改动就很难被接受。

## 报问题（最有用的形式）

一个能直接开工的 issue 长这样，按重要性排序：

1. **现象**：你看到什么、期望看到什么。一句话说清，别先写推测。
2. **截图**：面板上的错误框、错位的元素，比三行文字快十倍。
3. **复现路径**：点哪里 → 输什么 → 第几步出问题。能固定复现的步骤比「有时候会」有用得多。
4. **环境**：插件版本、DSH 版本、装了哪个版本的 `dsh-better-sidebar`（或没装）、操作系统、远端 sshd 类型。

用 issue 模板填就行。**不要把密码、私钥、真实主机地址贴进来** —— 需要的话替换成占位符。

如果问题是安全相关的，请走 [SECURITY.md](SECURITY.md)，不要开 public issue。

## 开发环境

```bash
git clone https://github.com/LinHao100076/dsh-remote-ssh.git
cd dsh-remote-ssh
npm ci
npm test          # 先 build 两个 bundle，再跑十三轮测试
```

- Node ≥ 20，纯 ESM。
- 没有 lint / formatter 配置，跟着现有代码走即可：2 空格缩进、单引号、**行尾不写分号**。
- 代码注释用英文（用于解释「为什么」），面向用户的文案用中文。

## 目录职责

| 路径 | 是什么 |
| --- | --- |
| `src/` | 宿主端：HTTP API、WebSocket 终端、SSH 连接池、文件、传输、同步、转发 |
| `client/` | 浏览器端：一个面板 + 若干视图 + 两个入口 |
| `lib/` | 构建产物，**提交进版本库**（安装时不需要构建），由 CI 校验是否与源码同步 |
| `ui/prototype.html` | 界面基准，单文件可直接打开 |
| `test/` | 测试，见 README 的表格 |
| `scripts/` | 对着真实服务器跑的验收脚本；`dev-remote.mjs` 是本地假远端 |

## 两条硬规则

**一、界面以 `ui/prototype.html` 为准。** 要改界面，先改原型，再改 `client/`。反过来做会导致原型和实现慢慢分家，之后没人知道哪个是对的。

**二、包里零运行期依赖。** `ssh2`、`ws`、`chokidar` 全部由 esbuild 内联进 `lib/server.mjs`。这一点不是洁癖：`link:` 安装的目录不会安装它自己的依赖，一旦有运行期依赖，用户在某种安装方式下会整个插件启用失败（`v0.3.1` 修的就是这个）。新依赖请加在 `devDependencies`，并确认它被 `build.mjs` 打进去了。

## 分支与提交

```bash
git switch -c feat/<短横线名字>          # 从 main 切
# …改…
git switch main
git merge --no-ff feat/<短横线名字>       # 合回 main
```

- **分支合完保留，不要删。** 回看某个功能的独立历史、在旧功能上接着改都要用到它。
- 提交信息用 conventional 前缀：`feat:` / `fix:` / `docs:` / `test:` / `chore:` / `refactor:`。
- 不要 `--amend` 已推送的提交，也不要 `push --force` 到 `main`。

## 测试要求

`npm test` 十三轮必须全绿。新增能力请配一个 `test/<名字>.mjs`，并把它加进 `package.json` 的 `scripts.test` 与 README 的测试表。

这个仓库对测试有一条底线：**关键协议不许打桩替代。** 具体说：

- 转发测试要跑真实 TCP 往返（本地 socket → 监听器 → `direct-tcpip` / `forwarded-tcpip` → 远端服务），而不是断言「调用了 forward 方法」。
- SOCKS5 要跑真实握手字节，包括被拆成多包到达、以及客户端把首包跟在握手后面一起发。
- 终端测试要用**构建产物里的** `WebSocketServer` 加真客户端对打（`v0.3.3` 的崩溃就是打桩掩盖掉的）。

反例：`v0.3.3` 之前，`ws` 被一个空对象打桩，`bufferUtil.unmask` 变成未捕获异常，一点终端就崩宿主 —— 断言「函数被调用过」的测试全绿，用户那边一用就炸。

## 提 PR 之前

- [ ] `npm test` 全绿，并且**提交里带上重建过的 `lib/`**（`pretest` 会自动 build，漏提交会在 CI 报 `lib/ 与源码不同步`）
- [ ] 新功能有对应测试；修的 bug 有能复现它的用例
- [ ] 改了界面的，`ui/prototype.html` 一起改
- [ ] 改了用户可见行为的，`README.md` 与 `CHANGELOG.md` 的 `未发布` 段落一起更新
- [ ] 有破坏性变更（规则模型、状态文件格式、API 形状）的，在 PR 描述里单独列出来，并说明旧数据怎么迁移

## 不打算做的事

省得白写代码，这几条是明确的方向性选择：

- 把插件做成一个完整的 SSH 客户端（它定位是「本地工作区的远端影子」）。
- 为了跑得快而在断点续传里并发写同一文件（会在 part 文件里留空洞，续传随之不可信 —— 详见 `docs/design.md` §8.14）。
- 引入运行期依赖。
- 用轮询代替事件去做「连接状态」之类的事。

## 协议

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。提交的代码按 [MIT](LICENSE) 授权。
