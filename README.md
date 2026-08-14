# dsh-feishu-bridge

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

1. **安装依赖包**（装入 DSH 的 profiles node_modules）：

   ```sh
   # 已发布到 npm 时：
   cd "$HOME/.dsh/profiles" && npm i dsh-feishu-bridge
   # 或从 git 仓库：
   cd "$HOME/.dsh/profiles" && npm i github:yourname/dsh-feishu-bridge
   ```

2. **启用**（二选一）：
   - 方式 A（推荐，bundle）：把包名加进 profile 的 `dsh.profile.bundles`（`$DSH_HOME/profiles/<profile>/package.json`）：
     ```json
     { "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-feishu-bridge"] } } }
     ```
   - 方式 B（patch 行）：在 profile 的 `cordis.patch.yml` 加入：
     ```yaml
     - insert:
         - id: feishu-bridge
           name: dsh-feishu-bridge
     ```

3. **重启** `dsh web`，然后在 设置 → 飞书机器人 填入 工作区 + AppID + AppSecret 并保存。

4. **飞书开放平台一次性配置**（与 cc-connect 相同）：
   - 创建企业自建应用，启用机器人
   - 权限：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:message.reaction`（可选，处理中表情用）
   - 事件与回调 → 订阅方式选 **「使用长连接接收事件」**，添加事件 `im.message.receive_v1`
   - 创建版本并发布

## 发布（维护者侧）

```sh
npm login
npm version patch
npm publish
```

发布前把 `package.json` 的 `name` 改成你的 scope（如 `@yourname/dsh-feishu-bridge`），并同步更新安装/启用文档里的包名。

## 架构

```
飞书开放平台 ⇄ WebSocket 长连接 ⇄ helper.cjs（本包，官方 SDK WSClient）
                                        ⇅ stdout JSON 行
                                   index.js（Host 插件，行 feishu-bridge）
                                        ⇅ ctx.agents / ctx.fs / ctx.shell / fetch
                                   Agent 会话（配置工作区匹配）
                                        ⇅ 同源 admin 路由 /feishu/admin/*
                                   client.js（设置页 UI，行 dsh-feishu-bridge）
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
