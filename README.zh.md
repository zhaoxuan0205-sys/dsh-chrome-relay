# dsh-chrome-relay

[English](README.md) · **中文**

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 直接操作**你正在用的 Chrome**：不用重新登录、不导出 Cookie、不保存任何凭证。

> 状态：实验性。已在 macOS + DSH 0.2.x + Chrome（官方 Playwright 扩展）上验证。

## 为什么做这个

浏览器自动化通常两条路：要么新开一个浏览器（所有站点都是未登录），要么复制你的配置和 Cookie（凭证离开了浏览器）。
这个插件走第三条：agent 只跟你**已经在用**的 Chrome 说话，而且由**你**决定它能碰哪个标签页。

## 安全模型

| 关注点 | 本插件的做法 |
| --- | --- |
| 登录态 | 留在 Chrome 里，只被借用，不被复制 |
| Cookie / storage | 不读取、不导出、不落盘 |
| 令牌 | 不需要、不保存；仅高级用户可用环境变量自行注入 |
| 授权范围 | Playwright 扩展弹窗让用户选标签页，只有选中的那个对 agent 可见 |
| 频率 | 每次 DSH 启动授权一次，本次会话内复用 |
| 来源 | 微软官方扩展 + 官方 `@playwright/mcp`，不带第三方扩展 |

**它不保护什么**：标签页被授权后，agent 就能在里面读 DOM、点击、输入。只授权你愿意交出去的页面；关闭标签或移除扩展即可收回。

## 工作原理

```
DSH ── dsh-mcp-client ── ~/.dsh/bin/browser-bridge-launch.sh
                              └─ node @playwright/mcp --extension
                     └─ Playwright 扩展中继（本地 WebSocket）
                          └─ 用户选中的标签页（含实时登录态）
```

工具名形如 `mcp__browser__browser_*`（`browser_tabs`、`browser_navigate`、`browser_evaluate` 等）。

## 前置条件

- DSH 0.2.x，profile 位于 `~/.dsh/profiles/<name>`（默认 `desktop`）
- Chrome 已安装官方 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)
- Node.js ≥ 20

## 安装

```bash
# 1) 依赖（固定版本，不下载浏览器）
pnpm add @playwright/mcp@0.0.84 --ignore-scripts

# 2) 注册到 profile（会先备份 profile 的 package.json）
node install.mjs                    # 或 node install.mjs --profile <dir>
#    依赖装在别处时：node install.mjs --cli /path/to/@playwright/mcp/cli.js

# 3) 链接进 profile
cd ~/.dsh/profiles/desktop && pnpm install

# 4) 重启 DSH
```

`install.mjs` 会把机器相关的东西写到 **`~/.dsh`** 下（启动脚本、输出目录），并生成本包的 `cordis.patch.yml`。
这些都不应该提交到仓库——包内自带一个空占位，安装后才替换成本机路径。

## 使用

```bash
node bin/check.mjs            # 只验证 MCP 是否被加载，约 1 秒
node bin/check.mjs --browser  # 完整握手：去 Chrome 里选标签页
node bin/eval.mjs --js "() => location.href"
```

退出码：`0` 正常，`2` MCP 未启动，`3` 浏览器握手失败。

建议的每次任务流程：

1. 先跑 `bin/check.mjs`，只在退出码 0 时继续；
2. 握手失败最多重试一次，仍失败就停下报告；
3. 被重定向到登录页或返回 `401` → 停止，不换账号、不换浏览器；
4. 永不复制 Cookie、`storageState` 或浏览器配置数据库。

## 安装后接受的风险

- **agent 会用你的身份在已授权标签页里操作**：能发帖、能删除、能改设置。
- **页面内容是外部输入**：恶意页面可以写文字诱导模型（提示注入）。本插件已关闭页面自带工具（`--no-webmcp`），但无法净化正文。
- **MCP 是本地 Node 子进程**，继承你的用户权限。
- **授权粒度是"每次启动一次"**，不是每次操作确认。
- 页面没有沙箱，只应授权你愿意交给外包的标签页。

## 卸载

```bash
cd ~/.dsh/profiles/desktop
# 从 package.json 的 dependencies 与 dsh.profile.bundles 中删除 dsh-chrome-relay
pnpm install
rm -f ~/.dsh/bin/browser-bridge-launch.sh
# 重启 DSH
```

## 稳定性：标签页死了会怎样

`--extension` 模式下，一个会话只绑定**一个标签页**。这个标签被关闭、刷新成登录页、Chrome 重启，或者扩展的 MV3 后台被浏览器休眠，Playwright 服务端就会一直等一个不会回应的目标。以前的表现是：**之后每一次工具调用都挂到客户端超时**——整个浏览器工具集看起来死了，在 Chrome 里怎么点都救不回来。

现在 `bin/mcp-watchdog.mjs` 挡在 DSH 和服务端之间：

| 行为 | 以前 | 现在 |
| --- | --- | --- |
| 调不到标签页 | 挂约 60 秒 | 8 秒内失败，并给出可操作提示 |
| 排在它后面的调用 | 一起挂 | 不再受牵连 |
| 驱动 `localhost` / `file://` | 允许（正是它把会话带死的） | 直接拒绝，错误码 `-32002` |
| 恢复方式 | 手工 `kill -TERM <pid>` | 自动重启服务端 |

可用 `DSH_RELAY_TIMEOUT_MS`（默认 `8000`）与 `DSH_RELAY_INIT_TIMEOUT_MS`（默认 `25000`）调整。

仍然卡住时，报错会说明是哪一类。手工兜底不变：

```sh
pgrep -fl "playwright/mcp/cli.js"
kill -TERM <pid>        # DSH 会在下次调用时重新拉起
```

`node bin/check.mjs --browser` 用来区分两类故障：`RESULT=browser-ok` 说明扩展可达；退出码 `3` 说明扩展连不上。

## 已知限制

- `@playwright/mcp --extension` 连接的是已安装扩展的 Chrome，不能凭空创建标签页。
- 每次 DSH 启动需要授权一次（这是设计取舍）。
- 端口与启动脚本路径因机器而异，安装时生成，不要提交。
- Windows 未测试（启动脚本是 POSIX `sh`）。

## 许可证

MIT，见 [LICENSE](LICENSE)。与 Google、Microsoft、DeepSeek 无隶属关系；Chrome、Playwright 为其各自所有者的商标。
