# dsh-feishu-connect

把飞书（Lark）机器人接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent 会话：通过官方 SDK **长连接**接收消息（无需公网 IP/域名/隧道），支持 cc-connect 风格的命令、每聊天独立会话、处理中表情、Markdown 卡片回复，并提供设置页 UI。

单包即用：一个 npm 包同时提供 Host 插件（桥接逻辑）+ Client 插件（设置页 UI）+ helper 子进程（长连接）+ bundle 补丁（自动注册）。

## 功能

- **接收/发送**：飞书 `im.message.receive_v1` 长连接 → 注入 Agent 会话 → 回复以交互卡片（Markdown）发回同一会话
- **命令**：`/new [名称]` 新建独立会话、`/switch <序号>` 切换、`/list` 列出、`/help` 帮助（支持前缀匹配 `/n` `/sw` `/l` `/h`）
- **会话**：按配置工作区精确匹配主会话；每聊天独立会话持久化（重启后自动恢复）；`agents.create/resume` 均注入模型选项（修复 `{{model}}` 变量缺失）
- **处理中表情**：消息到达加 `OnIt` 表情，回复送达后撤销（cc-connect 时机）；可配置 `reactionEmoji`，`none` 关闭
- **设置页**：设置 → 飞书机器人（工作区 / AppID / AppSecret / 状态 / 测试发送）
- **工具**：`feishu_send`（Agent 可主动发消息，缺省发到最近会话）

## 安装（用户侧）

一条命令装好，无需手改任何 JSON/YAML 配置文件：

```sh
# 已发布到 npm 时（推荐）：
dsh plugin --profile web add dsh-feishu-connect
# 或直接从 git 仓库安装：
dsh plugin --profile web add github:limingboGitHub/dsh-feishu-connect
```

> 首次安装若提示 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥10 默认拦截依赖的构建脚本，此处为 `protobufjs`）：编辑 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`，把 `allowBuilds` 下的 `protobufjs` 从 `set this to true or false` 改为 `true`，然后重新执行上面的命令。忽略该提示不影响功能，但需要放行后重跑一次，`dsh plugin` 才会把本插件写入 profile。

`dsh plugin` 会自动完成三件事：把包安装进 profile 的 node_modules、把本包的 `cordis.patch.yml` 作为 bundle 补丁层挂到 profile、并把包名写进 `dsh.profile.bundles` —— 全程无需编辑任何配置文件。

装完**重启**：

```sh
dsh web
```

然后在 **设置 → 飞书机器人** 填入 工作区 + AppID + AppSecret 并保存（无需手动创建 `feishu.config.json`，设置页会自动写入工作区根目录）。

> 手动安装（无 pnpm 环境）备选：把包放进 `$DSH_HOME/profiles/node_modules/`，在 profile 的 `cordis.patch.yml` 加入下面两行，重启即可：
> ```yaml
> - insert:
>     - id: feishu-bridge
>       name: dsh-feishu-connect
> ```
>
> ⚠️ **两种方式二选一，不要混用**：`dsh plugin` 会把包写入 `dsh.profile.bundles`（bundle 层），若 `cordis.patch.yml` 里还留着手动 `insert` 行，同一插件 id 会被注册两次，`dsh web` 启动会报 `duplicate loader entry id: feishu-bridge`。曾用手动方式装过的话，先删掉 `cordis.patch.yml` 里的 `insert` 行（恢复成 `[]`）再执行 `dsh plugin`，或反之。

### 飞书开放平台一次性配置（与 cc-connect 相同）
   - 创建企业自建应用，启用机器人
   - 权限：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:message.reaction`（可选，处理中表情用）
   - 事件与回调 → 订阅方式选 **「使用长连接接收事件」**，添加事件 `im.message.receive_v1`
   - 创建版本并发布

## 发布（维护者侧）

```sh
# 1. 登录 npm（首次）——注意用官方 registry，镜像源不能发布
npm login --registry https://registry.npmjs.org

# 2. 改版本号并发布
npm version patch
npm publish --registry https://registry.npmjs.org
```

包名已定为 `dsh-feishu-connect`（与 GitHub 仓库同名，npm 上可用的全局名）。若希望发布为 scope 包（如 `@yourname/dsh-feishu-connect`），把 `package.json` 的 `name` 改成 scope 形式后，用户侧安装命令随之变为：

```sh
dsh plugin --profile web add @yourname/dsh-feishu-connect
```

## 架构

```
飞书开放平台 ⇄ WebSocket 长连接 ⇄ helper.cjs（本包，官方 SDK WSClient）
                                        ⇅ stdout JSON 行
                                   index.js（Host 插件，行 feishu-bridge）
                                        ⇅ ctx.agents / ctx.fs / ctx.shell / fetch
                                   Agent 会话（配置工作区匹配）
                                        ⇅ 同源 admin 路由 /feishu/admin/*
                                   client.js（设置页 UI，行 dsh-feishu-connect）
```

- 配置：工作区根目录 `feishu.config.json`（`{ workspace, appId, appSecret, reactionEmoji? }`），热读；模板见包内 `feishu.config.example.json`（也可直接在设置页填写并保存）
- 会话状态：`<workspace>/.dsh-feishu/state.json`
- Host 插件注册：`feishu_send` 工具、`/feishu/admin/*` 路由、helper 进程管理（崩溃自动重启、凭据变更自动重连）

## 开发

```sh
npm i            # 安装 @larksuiteoapi/node-sdk
node --check index.js client.js helper.cjs
```

修改 `client.js` 后无需构建——client-modules 直接按内容哈希提供该文件，刷新浏览器即可生效（dev:web 下热换）。

## License

MIT
