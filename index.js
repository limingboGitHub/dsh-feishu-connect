// dsh-feishu-connect — host plugin (node half).
// Bridges Feishu (Lark) chats with the configured workspaces' agent
// conversations via the official SDK long connection (helper.cjs subprocess
// per bot), with cc-connect-style commands (/new /switch /list /help),
// per-chat sessions, a typing reaction, markdown cards, same-origin admin
// routes used by the settings-page bundle, and scan-to-create onboarding.
//
// Multi-bot model: the config holds a `bots` array; each bot is an
// independent { appId, appSecret, workspace } triple with its own long
// connection, session state, and command handling.

import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'feishu-bridge'

export const inject = ['shell', 'fs', 'agents', 'timer', 'webServer', 'tools']

// Absolute path of this package's helper process (the lark SDK long-connection
// subprocess the plugin spawns). Resolved from import.meta.url so the package
// can be installed anywhere (profiles node_modules, a profile workspace, a git
// dep). .cjs because the package is "type": "module" and the helper is CJS.
const HELPER_PATH = fileURLToPath(new URL('./helper.cjs', import.meta.url))

export function apply(ctx) {
  // ---- process-local state ----
  let stopping = false
  let lastConfigCheck = 0
  let lastSpawnAt = 0
  const bots = new Map()          // appId -> Bot runtime (see makeBot)
  let lastConfig = undefined      // cached parsed config

  // ---- config: ~/.cc-connect/feishu.config.json (cc-connect convention) ----
  const configPath = () => join(homedir(), '.cc-connect', 'feishu.config.json')

  const workspaceRoot = () => {
    const sp = ctx.get('sandboxPolicy')
    return sp && typeof sp.workspaceRoot === 'string' ? sp.workspaceRoot : undefined
  }

  // Normalize the config into { bots: [...] }. Legacy single-bot object
  // { workspace, appId, appSecret, reactionEmoji } is wrapped into bots.
  function normalizeConfig(raw) {
    const value = raw && typeof raw === 'object' ? raw : {}
    let list = Array.isArray(value.bots) ? value.bots : []
    if (list.length === 0 && typeof value.appId === 'string' && value.appId.length > 0) {
      const legacy = {
        workspace: typeof value.workspace === 'string' ? value.workspace : '',
        appId: value.appId,
        appSecret: typeof value.appSecret === 'string' ? value.appSecret : '',
        reactionEmoji: typeof value.reactionEmoji === 'string' ? value.reactionEmoji : undefined,
      }
      list = [legacy]
    }
    const cleaned = []
    for (const bot of list) {
      if (!bot || typeof bot !== 'object') continue
      const appId = typeof bot.appId === 'string' ? bot.appId.trim() : ''
      if (!appId) continue
      cleaned.push({
        name: typeof bot.name === 'string' && bot.name.trim() ? bot.name.trim() : appId,
        workspace: typeof bot.workspace === 'string' ? bot.workspace : '',
        appId,
        appSecret: typeof bot.appSecret === 'string' ? bot.appSecret : '',
        reactionEmoji: typeof bot.reactionEmoji === 'string' ? bot.reactionEmoji : undefined,
        ownerOpenId: typeof bot.ownerOpenId === 'string' ? bot.ownerOpenId : '',
        enabled: bot.enabled !== false,
      })
    }
    return cleaned
  }

  async function readConfig() {
    try {
      const target = configPath()
      if (!existsSync(target)) return []
      return normalizeConfig(JSON.parse(readFileSync(target, 'utf8')))
    } catch {
      return []
    }
  }

  async function writeConfig(botsList) {
    const target = configPath()
    mkdirSync(join(homedir(), '.cc-connect'), { recursive: true })
    writeFileSync(target, JSON.stringify({ bots: botsList }, null, 2))
  }

  // ---- path helpers ----
  const normalizePath = (p) => {
    if (typeof p !== 'string' || p.length === 0) return ''
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  // ---- outbound HTTP via the host's global fetch ----
  async function httpJson(url, method, headers, body) {
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        ...body === undefined ? {} : { body: JSON.stringify(body) },
      })
      const text = await response.text()
      return { status: response.status, text }
    } catch (error) {
      return { status: 0, text: String(error && error.message || error) }
    }
  }

  function parseJsonObject(text) {
    try {
      const value = JSON.parse(text)
      return value && typeof value === 'object' ? value : undefined
    } catch {
      return undefined
    }
  }

  // ---- Feishu send channel: app API, interactive card with markdown ----
  // Token cache is per-bot (token/tokenExpiresAt live on the Bot runtime).
  async function tenantAccessToken(bot, appId, appSecret) {
    const now = Date.now()
    if (bot.token && bot.tokenExpiresAt > now + 60000) return bot.token
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      'POST',
      { 'Content-Type': 'application/json' },
      { app_id: appId, app_secret: appSecret },
    )
    const parsed = parseJsonObject(res.text)
    if (parsed && parsed.code === 0 && typeof parsed.tenant_access_token === 'string') {
      bot.token = parsed.tenant_access_token
      bot.tokenExpiresAt = now + (Number(parsed.expire) || 7200) * 1000
      return bot.token
    }
    throw new Error('tenant_access_token failed: ' + (res.text || JSON.stringify(res)))
  }

  async function sendAppMessage(bot, appId, appSecret, target, text, receiveIdType) {
    const accessToken = await tenantAccessToken(bot, appId, appSecret)
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: text }],
    }
    const type = receiveIdType || 'chat_id'
    return httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + type,
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      { receive_id: target, msg_type: 'interactive', content: JSON.stringify(card) },
    )
  }

  async function sendFeishuText(bot, chatId, text) {
    const cfg = bot.cfg
    const hasCreds = typeof cfg.appId === 'string' && cfg.appId.length > 0
      && typeof cfg.appSecret === 'string' && cfg.appSecret.length > 0
    if (!hasCreds) {
      return { status: 0, text: '未配置 appId/appSecret：请到 设置 → 飞书机器人 填写并保存' }
    }
    // Delivery target priority:
    // 1. explicit chat_id
    // 2. the most recent chat this bot has seen
    // 3. the scanning user's open_id (creates a p2p chat automatically, so a
    //    brand-new bot can send its first message without any prior chat)
    const target = chatId || bot.lastChatId || ''
    if (target) return sendAppMessage(bot, cfg.appId, cfg.appSecret, target, text, 'chat_id')
    const owner = bot.cfg.ownerOpenId || ''
    if (owner) return sendAppMessage(bot, cfg.appId, cfg.appSecret, owner, text, 'open_id')
    return { status: 0, text: '没有可用的 chat_id：先在飞书里给机器人发一条消息（插件会自动记录该会话），或手动填写 chat_id' }
  }

  // ---- typing reaction (cc-connect StartTyping): added on arrival, removed
  //      only AFTER the reply is delivered (EventResult-then-stop order) ----
  async function addReaction(bot, appId, appSecret, messageId, emoji) {
    const accessToken = await tenantAccessToken(bot, appId, appSecret)
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reactions',
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      { reaction_type: { emoji_type: emoji } },
    )
    const parsed = parseJsonObject(res.text)
    if (!(res.status >= 200 && res.status < 300) || !parsed || parsed.code !== 0) {
      throw new Error('reaction create failed: ' + (res.text || JSON.stringify(res)))
    }
    return parsed.data && parsed.data.reaction_id ? { reaction_id: parsed.data.reaction_id } : {}
  }

  async function removeReaction(bot, appId, appSecret, messageId, reactionId) {
    const accessToken = await tenantAccessToken(bot, appId, appSecret)
    return httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId)
        + '/reactions/' + encodeURIComponent(reactionId),
      'DELETE',
      { Authorization: 'Bearer ' + accessToken },
      undefined,
    )
  }

  // ---- agent selection: the live agent whose session belongs to the bot's workspace ----
  const pickAgent = (workspace) => {
    const agents = ctx.get('agents')
    if (!agents) return undefined
    const target = normalizePath(workspace || workspaceRoot() || '')
    if (!target) return undefined
    const matches = (agent) => {
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      return normalizePath(cwd) === target
    }
    const roots = agents.roots().filter(matches)
    if (roots.length > 0) return roots[0]
    const all = agents.list().filter(matches)
    if (all.length > 0) return all[0]
    return undefined
  }

  // ---- dedicated per-chat sessions (cc-connect style) ----
  const defaultAgentOptions = () => {
    const selection = ctx.get('agentDefaultModel')
    const selected = selection && typeof selection.currentSelection === 'function'
      ? selection.currentSelection() : undefined
    return selected ? { provider: selected.provider, model: selected.model } : undefined
  }

  async function createDedicated(bot, sessionId, mainAgent) {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents service unavailable')
    const cfg = bot.cfg
    const preset = mainAgent && mainAgent.session && mainAgent.session.header
      ? mainAgent.session.header.agentPreset : undefined
    return agents.create({
      sessionId,
      meta: {
        cwd: (cfg.workspace && String(cfg.workspace).trim()) || workspaceRoot() || undefined,
        ...preset ? { agentPreset: preset } : {},
      },
      ...defaultAgentOptions() ? { agentOptions: defaultAgentOptions() } : {},
      setup: async (agentCtx) => {
        const presets = agentCtx.get('agentPresets')
        if (!presets) return
        if (mainAgent) {
          const joined = presets.composeFrom(agentCtx, mainAgent.ctx)
          if (!joined) console.log('[feishu] dedicated session joined no preset (parent not composed)')
        } else {
          try {
            await presets.mount(agentCtx)
          } catch (error) {
            console.log('[feishu] dedicated session preset mount failed: ' + String(error && error.message || error))
          }
        }
      },
    })
  }

  async function resumeDedicated(bot, sessionId, mainAgent) {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents service unavailable')
    return agents.resume({
      resumeSessionId: sessionId,
      ...defaultAgentOptions() ? { agentOptions: defaultAgentOptions() } : {},
      setup: async (agentCtx) => {
        if (!mainAgent) return
        const presets = agentCtx.get('agentPresets')
        if (!presets) return
        try {
          presets.composeFrom(agentCtx, mainAgent.ctx)
        } catch (error) {
          console.log('[feishu] resumed session composeFrom failed: ' + String(error && error.message || error))
        }
      },
    })
  }

  function chatSessionId(chatId, n) {
    const safe = String(chatId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'chat'
    return 'feishu-' + safe + '-' + n + '-' + Date.now().toString(36)
  }

  // ---- commands ----
  const COMMANDS = ['help', 'new', 'switch', 'list']

  function resolveCommand(name) {
    if (!name) return undefined
    const exact = COMMANDS.find((c) => c === name)
    if (exact) return exact
    const prefix = COMMANDS.filter((c) => c.startsWith(name))
    return prefix.length === 1 ? prefix[0] : undefined
  }

  const HELP_TEXT = [
    '**飞书机器人命令**',
    '',
    '/new [名称] — 新建独立会话并切换到它（可不填名称）',
    '/switch <序号> — 切换会话（/list 查看序号）',
    '/list — 列出本聊天的全部会话',
    '/help — 显示本帮助',
    '',
    '支持前缀匹配：/n、/sw、/l、/h',
  ].join('\n')

  async function handleCommand(bot, chatId, cmdLine) {
    const cfg = bot.cfg
    const parts = String(cmdLine).trim().split(/\s+/)
    const rawName = (parts[0] || '').toLowerCase()
    const name = resolveCommand(rawName.startsWith('/') ? rawName.slice(1) : rawName)
    if (!name) {
      await sendFeishuText(bot, chatId, '未知命令 `' + parts[0] + '`，发送 /help 查看可用命令。')
      return
    }
    const chat = await bot.ensureChat(chatId)
    const mainAgent = pickAgent(cfg.workspace)

    if (name === 'help') {
      await sendFeishuText(bot, chatId, HELP_TEXT)
      return
    }
    if (name === 'list') {
      const lines = ['**会话列表**', '']
      for (let i = 0; i < chat.sessions.length; i++) {
        const s = chat.sessions[i]
        const marker = i === chat.activeIndex ? '（当前）' : ''
        lines.push(String(i + 1) + '. ' + s.label + (s.type === 'dedicated' ? '（独立）' : '') + marker)
      }
      lines.push('', '发送 /switch <序号> 切换会话')
      await sendFeishuText(bot, chatId, lines.join('\n'))
      return
    }
    if (name === 'new') {
      const label = parts.slice(1).join(' ').trim() || ('会话 ' + (chat.sessions.length + 1))
      try {
        const sessionId = chatSessionId(chatId, chat.sessions.length)
        const handle = await createDedicated(bot, sessionId, mainAgent)
        chat.sessions.push({ id: sessionId, label, type: 'dedicated', handle })
        chat.activeIndex = chat.sessions.length - 1
        await bot.persistChat(chatId, chat)
        await sendFeishuText(bot, chatId, '已创建独立会话 **' + label + '** 并切换。\n\n之后的消息将进入新会话；/switch 1 可回到主会话。')
      } catch (error) {
        console.log('[feishu] /new failed: ' + String(error && error.stack || error))
        await sendFeishuText(bot, chatId, '创建会话失败：' + String(error && error.message || error))
      }
      return
    }
    if (name === 'switch') {
      const arg = (parts[1] || '').trim()
      if (!arg) {
        const lines = ['**会话列表**', '']
        for (let i = 0; i < chat.sessions.length; i++) {
          const s = chat.sessions[i]
          const marker = i === chat.activeIndex ? '（当前）' : ''
          lines.push(String(i + 1) + '. ' + s.label + (s.type === 'dedicated' ? '（独立）' : '') + marker)
        }
        lines.push('', '发送 /switch <序号> 切换会话')
        await sendFeishuText(bot, chatId, lines.join('\n'))
        return
      }
      const index = Number(arg)
      if (!Number.isInteger(index) || index < 1 || index > chat.sessions.length) {
        await sendFeishuText(bot, chatId, '无效序号：`' + arg + '`。发送 /list 查看可用会话。')
        return
      }
      chat.activeIndex = index - 1
      await bot.persistChat(chatId, chat)
      const entry = chat.sessions[chat.activeIndex]
      await sendFeishuText(bot, chatId, '已切换到 **' + entry.label + '**' + (entry.type === 'dedicated' ? '（独立会话）' : '（主会话）') + '。')
    }
  }

  // ---- bridge: Feishu message -> agent turn -> reply back to Feishu ----
  function extractReply(events, fromSeq) {
    let reply = ''
    for (let i = fromSeq; i < events.length; i++) {
      const event = events[i]
      if (!event || event.type !== 'assistant/message') continue
      const message = event.data && event.data.message
      const blocks = message && message.content ? message.content : []
      let text = ''
      for (const block of blocks) {
        if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
      }
      if (text.trim().length > 0) reply = text
    }
    return reply.trim()
  }

  async function handleFeishuMessage(bot, evt) {
    const cfg = bot.cfg
    const messageId = evt.message_id
    if (typeof messageId !== 'string' || messageId.length === 0) return
    if (evt.chat_id) bot.lastChatId = evt.chat_id
    if (bot.seen.has(messageId)) return // redelivery guard
    if (bot.seen.size > bot.MAX_SEEN) bot.seen.clear()
    bot.seen.add(messageId)

    if (evt.message_type !== 'text') {
      console.log('[feishu] ignore non-text message ' + messageId + ' (' + String(evt.message_type) + ')')
      return
    }
    let text = ''
    try {
      text = (JSON.parse(evt.content || '{}').text || '').trim()
    } catch {
      text = ''
    }
    if (text.length === 0) return

    const chatId = evt.chat_id

    // commands are handled by the plugin itself, never injected into an agent
    if (text.startsWith('/')) {
      await handleCommand(bot, chatId, text)
      return
    }

    // Feishu messages always go to a dedicated session owned by this chat —
    // never to a GUI session (pickAgent matches the configured workspace's
    // live agent, which is the GUI session the user is looking at). Each chat
    // gets its own agent session pool, created on first message.
    const chat = await bot.ensureChat(chatId)
    let agent = await bot.resolveActiveAgent(chat)
    if (!agent) {
      console.log('[feishu] creating dedicated session for chat ' + chatId + ' (workspace ' + (cfg.workspace || '?') + ')')
      try {
        const sessionId = 'feishu-main-' + Date.now().toString(36)
        const handle = await createDedicated(bot, sessionId, undefined)
        agent = handle.agent
        // make the auto-created session the chat's main session so later
        // messages keep landing in it
        chat.sessions = [{ id: sessionId, label: '主会话', type: 'dedicated', handle }]
        chat.activeIndex = 0
        await bot.persistChat(chatId, chat)
      } catch (error) {
        console.log('[feishu] auto-create agent failed: ' + String(error && error.stack || error))
        await sendFeishuText(bot, chatId, '创建 Agent 会话失败：'
          + (cfg.workspace || workspaceRoot() || '?') + '。请检查工作区配置后重试，或发送 /new 手动创建。')
        return
      }
    }

    const openId = evt.sender && evt.sender.sender_id && evt.sender.sender_id.open_id || ''
    const label = openId ? '[飞书 ' + openId + '] ' : '[飞书消息] '
    const seqBefore = agent.session.events.length
    const message = {
      id: 'feishu-' + messageId,
      role: 'user',
      content: [{ type: 'text', text: label + text }],
      source: { kind: 'user' },
    }
    agent.send(message, 'next-turn', true)
    console.log('[feishu] delivered ' + messageId + ' to agent ' + agent.id + ' (workspace ' + (agent.session.header && agent.session.header.cwd || '?') + ')')

    // typing reaction: added when the message arrives; removed only AFTER the
    // reply is delivered to the chat (cc-connect EventResult-then-stop order),
    // or when the turn fails.
    const emoji = (cfg.reactionEmoji && String(cfg.reactionEmoji).trim()) || 'OnIt'
    const typingEnabled = emoji && emoji !== '' && emoji !== 'none'
      && typeof cfg.appId === 'string' && cfg.appId.length > 0
      && typeof cfg.appSecret === 'string' && cfg.appSecret.length > 0
    let reactionId = undefined
    let reactionRemoved = false
    const removeReactionOnce = () => {
      if (reactionRemoved || !reactionId) return
      reactionRemoved = true
      void removeReaction(bot, cfg.appId, cfg.appSecret, messageId, reactionId).catch((error) => {
        console.log('[feishu] reaction remove failed: ' + String(error && error.message || error))
      })
    }
    if (typingEnabled) {
      try {
        const r = await addReaction(bot, cfg.appId, cfg.appSecret, messageId, emoji)
        reactionId = r && r.reaction_id
      } catch (error) {
        console.log('[feishu] reaction add failed (needs im:message.reaction permission): '
          + String(error && error.message || error))
      }
    }

    try {
      await agent.whenIdle()
    } catch (error) {
      console.log('[feishu] turn wait failed for ' + messageId + ': ' + String(error && error.message || error))
      removeReactionOnce()
      return
    }

    const reply = extractReply(agent.session.events, seqBefore) || '（Agent 未产生文字回复）'
    try {
      const res = await sendFeishuText(bot, chatId, reply)
      console.log('[feishu] reply to ' + chatId + ' (msg ' + messageId + '): status=' + String(res.status))
      if (res.status !== 200 && res.text) console.log('[feishu] send response: ' + res.text.slice(0, 500))
    } catch (error) {
      console.log('[feishu] send failed for ' + messageId + ': ' + String(error && error.message || error))
    } finally {
      // reply delivered (or send failed) -> stop the typing reaction now
      removeReactionOnce()
    }
  }

  function normalizeEvent(data) {
    const d = data && typeof data === 'object' ? data : {}
    const message = d.message || (d.event && d.event.message) || {}
    const sender = d.sender || (d.event && d.event.sender) || {}
    return {
      message_id: message.message_id,
      message_type: message.message_type,
      chat_id: message.chat_id,
      chat_type: message.chat_type,
      content: message.content,
      create_time: message.create_time,
      sender,
    }
  }

  // ---- helper process lifecycle (one per bot) ----
  function quoteArg(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }

  function spawnHelper(bot) {
    const cfg = bot.cfg
    const appId = cfg.appId && String(cfg.appId).trim()
    const appSecret = cfg.appSecret && String(cfg.appSecret).trim()
    if (!appId || !appSecret) return
    const key = appId + '|' + appSecret + '|' + String(cfg.workspace || '')
    if (bot.proc && bot.proc.status === 'running' && bot.procKey === key) return
    lastSpawnAt = Date.now()
    if (bot.proc) {
      try { bot.proc.kill() } catch { /* ignore */ }
    }
    const spec = ctx.shell.resolve({
      command: 'node ' + quoteArg(HELPER_PATH) + ' ' + quoteArg(appId) + ' ' + quoteArg(appSecret),
    })
    bot.proc = ctx.shell.start(spec)
    bot.procKey = key
    console.log('[feishu] helper spawned (app ' + appId + ')')
  }

  async function ensureHelper() {
    const now = Date.now()
    if (stopping) return
    const refresh = now - lastConfigCheck >= 10000
    if (refresh) lastConfigCheck = now
    const list = await readConfig()
    lastConfig = list

    // Stop helpers whose bot was removed from config.
    for (const [appId, bot] of bots) {
      if (!list.some((c) => c.appId === appId)) {
        console.log('[feishu] bot ' + appId + ' removed from config; stopping helper')
        try { if (bot.proc) bot.proc.kill() } catch { /* ignore */ }
        bots.delete(appId)
      }
    }

    // Ensure one helper per configured bot.
    for (const cfg of list) {
      let bot = bots.get(cfg.appId)
      if (!bot) {
        bot = makeBot(cfg)
        bots.set(cfg.appId, bot)
      } else {
        bot.cfg = cfg
      }
      const appId = cfg.appId
      const appSecret = cfg.appSecret
      const key = appId + '|' + appSecret + '|' + String(cfg.workspace || '')
      if (!appId || !appSecret) {
        if (bot.proc && bot.proc.status === 'running') {
          console.log('[feishu] config cleared for ' + appId + '; stopping helper')
          try { bot.proc.kill() } catch { /* ignore */ }
          bot.proc = undefined
        }
        continue
      }
      // Connection switch: disabled bots have no helper process and are not
      // respawned until enabled again.
      if (cfg.enabled === false) {
        if (bot.proc) {
          console.log('[feishu] bot ' + appId + ' disabled; stopping helper')
          try { bot.proc.kill() } catch { /* ignore */ }
          bot.proc = undefined
          bot.status = ''
        }
        continue
      }
      if (!refresh && bot.proc && bot.proc.status === 'running') continue
      if (now - lastSpawnAt < 5000 && bot.proc && bot.proc.status === 'running') continue
      if (bot.proc && bot.proc.status === 'running' && bot.procKey === key) continue
      spawnHelper(bot)
    }
  }

  function drainOutput() {
    for (const bot of bots.values()) {
      if (!bot.proc) continue
      try {
        const read = bot.proc.readOutput()
        if (read && read.delta) {
          for (const line of read.delta.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let msg
            try { msg = JSON.parse(trimmed) } catch { continue }
            handleHelperMessage(bot, msg)
          }
        }
      } catch (error) {
        console.log('[feishu] drain error: ' + String(error && error.message || error))
      }
    }
  }

  function handleHelperMessage(bot, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'event' && msg.eventType === 'im.message.receive_v1') {
      const evt = normalizeEvent(msg.data)
      bot.chain = bot.chain.then(() => handleFeishuMessage(bot, evt)).catch((error) => {
        console.log('[feishu] handler error: ' + String(error && error.stack || error))
      })
      return
    }
    if (msg.type === 'ready') {
      bot.status = 'connected'
      console.log('[feishu] WebSocket long connection ready (app ' + bot.cfg.appId + ')')
      return
    }
    if (msg.type === 'error') {
      console.log('[feishu] helper error: ' + String(msg.message))
      return
    }
    if (msg.type === 'status') {
      const state = msg.status && msg.status.state ? msg.status.state : '?'
      const attempts = msg.status && msg.status.reconnectAttempts ? '/' + String(msg.status.reconnectAttempts) : ''
      const line = state + attempts
      if (line !== bot.status) {
        bot.status = line
        console.log('[feishu] connection status (app ' + bot.cfg.appId + '): ' + line)
      }
      return
    }
  }

  // ---- per-bot runtime ----
  function makeBot(cfg) {
    const stateFile = () => join(homedir(), '.cc-connect', 'state-' + String(cfg.appId).replace(/[^a-zA-Z0-9]/g, '') + '.json')
    const bot = {
      cfg,
      proc: undefined,
      procKey: '',
      status: '',
      chain: Promise.resolve(),
      seen: new Set(),
      MAX_SEEN: 500,
      token: undefined,
      tokenExpiresAt: 0,
      lastChatId: '',
      chats: new Map(),
      stateCache: undefined,
      stateFile,

      async ensureChat(chatId) {
        const existing = this.chats.get(chatId)
        if (existing) return existing
        const state = await this.loadState()
        const record = state.chats && state.chats[chatId]
        const chat = { sessions: [], activeIndex: 0 }
        if (record && Array.isArray(record.sessions) && record.sessions.length > 0) {
          for (const s of record.sessions) {
            if (s && s.type === 'dedicated' && typeof s.id === 'string') {
              chat.sessions.push({ id: s.id, label: typeof s.label === 'string' && s.label ? s.label : '会话', type: 'dedicated' })
            } else {
              chat.sessions.push({ id: 'main', label: '主会话', type: 'main' })
            }
          }
          const ai = record.sessions.findIndex((s) => s && s.id === record.active)
          chat.activeIndex = ai >= 0 ? ai : 0
        } else {
          chat.sessions = [{ id: 'main', label: '主会话', type: 'main' }]
        }
        this.chats.set(chatId, chat)
        return chat
      },

      async loadState() {
        if (this.stateCache !== undefined) return this.stateCache
        this.stateCache = { chats: {} }
        try {
          const target = this.stateFile()
          if (!existsSync(target)) return this.stateCache
          const parsed = JSON.parse(readFileSync(target, 'utf8'))
          if (parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object') {
            this.stateCache = parsed
          }
        } catch {
          // first run: no state file yet
        }
        return this.stateCache
      },

      async saveState() {
        try {
          const target = this.stateFile()
          mkdirSync(join(homedir(), '.cc-connect'), { recursive: true })
          writeFileSync(target, JSON.stringify(this.stateCache || { chats: {} }, null, 2))
        } catch (error) {
          console.log('[feishu] state save failed: ' + String(error && error.message || error))
        }
      },

      async persistChat(chatId, chat) {
        const state = await this.loadState()
        if (!state.chats) state.chats = {}
        state.chats[chatId] = {
          sessions: chat.sessions.map((s) => ({ id: s.id, label: s.label, type: s.type })),
          active: chat.sessions[chat.activeIndex] ? chat.sessions[chat.activeIndex].id : (chat.sessions[0] ? chat.sessions[0].id : 'main'),
        }
        await this.saveState()
      },

      async resolveActiveAgent(chat, mainAgent) {
        const entry = chat.sessions[chat.activeIndex]
        if (!entry) return undefined
        // 'main' entries no longer resolve to a GUI session — every chat owns
        // its sessions; a persisted 'main' record without a dedicated id is a
        // legacy entry, treat it as needing (re)creation.
        if (entry.type === 'main') return undefined
        if (entry.handle) return entry.handle.agent
        try {
          const handle = await resumeDedicated(this, entry.id, mainAgent)
          entry.handle = handle
          return handle.agent
        } catch (error) {
          console.log('[feishu] resume failed for ' + entry.id + ': ' + String(error && error.message || error))
          return undefined
        }
      },
    }
    return bot
  }

  // ---- admin HTTP routes (same-origin RPC for the settings-page client) ----
  function respondJson(res, status, obj) {
    if (res.headersSent) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          req.destroy()
          reject(new Error('payload too large'))
          return
        }
        chunks.push(chunk.toString('utf8'))
      })
      req.on('end', () => resolve(chunks.join('')))
      req.on('error', reject)
    })
  }

  function connectionLabel(bot) {
    if (bot.status) return bot.status
    if (bot.proc && bot.proc.status === 'running') return 'connecting'
    return 'idle'
  }

  async function handleAdminStatus(res) {
    const list = await readConfig()
    respondJson(res, 200, {
      bots: list.map((cfg) => {
        const bot = bots.get(cfg.appId)
        return {
          name: cfg.name || cfg.appId,
          workspace: cfg.workspace,
          appId: cfg.appId,
          hasSecret: !!(cfg.appSecret && String(cfg.appSecret).length > 0),
          enabled: cfg.enabled !== false,
          connection: bot ? connectionLabel(bot) : 'idle',
          helperRunning: !!(bot && bot.proc && bot.proc.status === 'running'),
          lastChatId: bot ? bot.lastChatId : '',
        }
      }),
    })
  }

  async function handleAdminConfig(req, res, method) {
    if (method === 'GET') {
      await handleAdminStatus(res)
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req, 65536))
    } catch {
      respondJson(res, 400, { ok: false, message: 'invalid json body' })
      return
    }
    const current = await readConfig()
    let next = current.map((c) => ({ ...c }))
    if (Array.isArray(body.bots)) {
      // The client's bot list never carries appSecret (status only exposes
      // hasSecret); preserve the stored secret when the payload leaves it
      // empty, and keep any removed-by-absent bot out of the list.
      const incoming = body.bots.map((b) => ({
        name: typeof b.name === 'string' ? b.name.trim() : '',
        workspace: typeof b.workspace === 'string' ? b.workspace.trim() : '',
        appId: typeof b.appId === 'string' ? b.appId.trim() : '',
        appSecret: typeof b.appSecret === 'string' ? b.appSecret.trim() : '',
        reactionEmoji: typeof b.reactionEmoji === 'string' ? b.reactionEmoji : undefined,
        ownerOpenId: typeof b.ownerOpenId === 'string' ? b.ownerOpenId : '',
        enabled: b.enabled !== false,
      })).filter((b) => b.appId)
      next = incoming.map((b) => {
        const prev = current.find((c) => c.appId === b.appId)
        return {
          ...b,
          appSecret: b.appSecret || (prev ? prev.appSecret : ''),
          reactionEmoji: b.reactionEmoji !== undefined ? b.reactionEmoji : (prev ? prev.reactionEmoji : undefined),
          ownerOpenId: b.ownerOpenId || (prev ? prev.ownerOpenId : ''),
        }
      })
    } else if (body.appId) {
      // single-bot payload: upsert into the list
      const index = next.findIndex((c) => c.appId === String(body.appId).trim())
      const entry = {
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : String(body.appId).trim(),
        workspace: typeof body.workspace === 'string' ? body.workspace.trim() : (index >= 0 ? next[index].workspace : ''),
        appId: String(body.appId).trim(),
        appSecret: typeof body.appSecret === 'string' && body.appSecret.trim().length > 0
          ? body.appSecret.trim()
          : (index >= 0 ? next[index].appSecret : ''),
        reactionEmoji: typeof body.reactionEmoji === 'string' ? body.reactionEmoji : (index >= 0 ? next[index].reactionEmoji : undefined),
        ownerOpenId: typeof body.ownerOpenId === 'string' ? body.ownerOpenId : (index >= 0 ? next[index].ownerOpenId : ''),
        enabled: body.enabled !== undefined ? !!body.enabled : (index >= 0 ? next[index].enabled !== false : true),
      }
      if (index >= 0) next[index] = entry
      else next.push(entry)
    }
    try {
      await writeConfig(next)
      lastConfigCheck = 0
      void ensureHelper()
      respondJson(res, 200, { ok: true, message: '配置已保存到 ' + configPath() })
    } catch (error) {
      respondJson(res, 500, { ok: false, message: '保存失败: ' + String(error && error.message || error) })
    }
  }

  async function handleAdminDeleteBot(req, res) {
    let body = {}
    try {
      body = JSON.parse(await readBody(req, 65536)) || {}
    } catch {
      respondJson(res, 400, { ok: false, message: 'invalid json body' })
      return
    }
    const appId = body.appId
    if (typeof appId !== 'string' || appId.length === 0) {
      respondJson(res, 400, { ok: false, message: 'appId required' })
      return
    }
    const list = await readConfig()
    const next = list.filter((c) => c.appId !== appId)
    if (next.length === list.length) {
      respondJson(res, 404, { ok: false, message: 'bot not found' })
      return
    }
    await writeConfig(next)
    const bot = bots.get(appId)
    if (bot) {
      try { if (bot.proc) bot.proc.kill() } catch { /* ignore */ }
      bots.delete(appId)
    }
    respondJson(res, 200, { ok: true, message: '已删除机器人 ' + appId })
  }

  // Toggle a bot's connection at runtime: saves `enabled` and immediately
  // starts/stops its helper process (no restart needed).
  async function handleAdminToggle(req, res) {
    let body = {}
    try {
      body = JSON.parse(await readBody(req, 65536)) || {}
    } catch {
      respondJson(res, 400, { ok: false, message: 'invalid json body' })
      return
    }
    const appId = body.appId
    if (typeof appId !== 'string' || appId.length === 0) {
      respondJson(res, 400, { ok: false, message: 'appId required' })
      return
    }
    const list = await readConfig()
    const index = list.findIndex((c) => c.appId === appId)
    if (index < 0) {
      respondJson(res, 404, { ok: false, message: 'bot not found' })
      return
    }
    const enabled = body.enabled !== undefined ? !!body.enabled : !(list[index].enabled !== false)
    const next = list.map((c, i) => i === index ? { ...c, enabled } : c)
    await writeConfig(next)
    lastConfigCheck = 0
    void ensureHelper()
    respondJson(res, 200, { ok: true, enabled, message: (enabled ? '已启用' : '已停用') + '机器人 ' + appId })
  }

  function botFromBody(body) {
    const appId = body && typeof body.appId === 'string' ? body.appId.trim() : ''
    if (!appId) return undefined
    const list = lastConfig || []
    const cfg = list.find((c) => c.appId === appId)
    if (!cfg) return undefined
    let bot = bots.get(appId)
    if (!bot) {
      bot = makeBot(cfg)
      bots.set(appId, bot)
    }
    return bot
  }

  async function handleAdminSendTest(req, res) {
    let body = {}
    try {
      body = JSON.parse(await readBody(req, 65536)) || {}
    } catch {
      respondJson(res, 400, { ok: false, status: 0, detail: 'invalid json body' })
      return
    }
    const bot = botFromBody(body)
    if (!bot) {
      respondJson(res, 200, { ok: false, status: 0, detail: '未找到 appId 对应的机器人配置' })
      return
    }
    const chatId = typeof body.chatId === 'string' && body.chatId.length > 0 ? body.chatId : undefined
    const text = typeof body.text === 'string' && body.text.length > 0 ? body.text : '测试消息'
    try {
      const result = await sendFeishuText(bot, chatId, text)
      respondJson(res, 200, {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        detail: String(result.text || '').slice(0, 1000),
      })
    } catch (error) {
      respondJson(res, 200, { ok: false, status: 0, detail: String(error && error.message || error) })
    }
  }

  // ---- Feishu official app-registration onboarding (device flow).
  // POST https://accounts.feishu.cn/oauth/v1/app/registration with
  // form-encoded { action, ... } — the same public API cc-connect uses:
  //   init  -> supported_auth_methods (must include client_secret)
  //   begin -> device_code + verification_uri_complete (the QR payload)
  //   poll  -> client_id/client_secret once the user scanned and confirmed
  const onboardingBase = 'https://accounts.feishu.cn/oauth/v1/app/registration'
  const onboardingForm = (params) => {
    const parts = Object.entries(params).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    return { body: parts.join('&'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  }

  async function onboardingCall(params) {
    const init = onboardingForm({ action: 'init' })
    const initRes = await fetch(onboardingBase, { method: 'POST', headers: init.headers, body: init.body })
    if (!initRes.ok) throw new Error('onboarding init http ' + initRes.status)
    const initData = await initRes.json()
    if (!Array.isArray(initData.supported_auth_methods)
      || !initData.supported_auth_methods.some((m) => String(m).toLowerCase() === 'client_secret')) {
      throw new Error('current environment does not support client_secret auth')
    }
    const begin = onboardingForm({ action: 'begin', ...params })
    const beginRes = await fetch(onboardingBase, { method: 'POST', headers: begin.headers, body: begin.body })
    if (!beginRes.ok) throw new Error('onboarding begin http ' + beginRes.status)
    const beginData = await beginRes.json()
    if (beginData.error) throw new Error(String(beginData.error) + ': ' + String(beginData.error_description || ''))
    return beginData
  }

  async function onboardingPoll(deviceCode) {
    const form = onboardingForm({ action: 'poll', device_code: deviceCode })
    const res = await fetch(onboardingBase, { method: 'POST', headers: form.headers, body: form.body })
    if (!res.ok) throw new Error('onboarding poll http ' + res.status)
    return await res.json()
  }

  async function handleAdminOnboard(req, res) {
    try {
      const data = await onboardingCall({
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id',
      })
      if (!data.device_code || !data.verification_uri_complete) {
        throw new Error('incomplete onboarding response')
      }
      // qrcode is a CJS package; dynamic import keeps this ESM host plugin clean.
      let qrDataUrl = ''
      try {
        const { toDataURL } = await import('qrcode')
        qrDataUrl = await toDataURL(data.verification_uri_complete, { margin: 1, width: 240 })
      } catch (error) {
        console.log('[feishu] qr render failed: ' + String(error && error.message || error))
      }
      respondJson(res, 200, {
        ok: true,
        deviceCode: data.device_code,
        qrContent: data.verification_uri_complete,
        qrDataUrl,
        userCode: typeof data.user_code === 'string' ? data.user_code : '',
        expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 3600,
        interval: typeof data.interval === 'number' ? data.interval : 5,
      })
    } catch (error) {
      respondJson(res, 500, { ok: false, message: String(error && error.message || error) })
    }
  }

  async function handleAdminOnboardPoll(req, res) {
    let body = {}
    try {
      body = JSON.parse(await readBody(req, 65536)) || {}
    } catch {
      respondJson(res, 400, { ok: false, message: 'invalid json body' })
      return
    }
    const deviceCode = body.deviceCode
    if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
      respondJson(res, 400, { ok: false, message: 'deviceCode required' })
      return
    }
    try {
      const data = await onboardingPoll(deviceCode)
      if (data.error && data.error !== 'authorization_pending') {
        respondJson(res, 200, { ok: false, error: String(data.error), message: String(data.error_description || data.error) })
        return
      }
      if (typeof data.client_id === 'string' && typeof data.client_secret === 'string'
        && data.client_id.length > 0 && data.client_secret.length > 0) {
        respondJson(res, 200, {
          ok: true,
          done: true,
          appId: data.client_id,
          appSecret: data.client_secret,
          ownerOpenId: data.user_info && typeof data.user_info.open_id === 'string' ? data.user_info.open_id : '',
          platform: String(data.user_info && data.user_info.tenant_brand || 'feishu').toLowerCase(),
        })
        return
      }
      respondJson(res, 200, { ok: true, done: false, pending: true })
    } catch (error) {
      respondJson(res, 500, { ok: false, message: String(error && error.message || error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/feishu/admin/status',
    handler: (req, res) => {
      if (req.method !== 'GET') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      void handleAdminStatus(res)
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/feishu/admin/config',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      }
      void handleAdminConfig(req, res, req.method)
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/feishu/admin/delete-bot',
    handler: (req, res) => {
      if (req.method !== 'POST') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      void handleAdminDeleteBot(req, res)
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/feishu/admin/toggle',
    handler: (req, res) => {
      if (req.method !== 'POST') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      void handleAdminToggle(req, res)
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/feishu/admin/send-test',
    handler: (req, res) => {
      if (req.method !== 'POST') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      void handleAdminSendTest(req, res)
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/feishu/admin/onboard',
    handler: (req, res) => {
      if (req.method !== 'POST') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      void handleAdminOnboard(req, res)
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/feishu/admin/onboard/poll',
    handler: (req, res) => {
      if (req.method !== 'POST') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      void handleAdminOnboardPoll(req, res)
    },
  }))

  // ---- model tool: send a Feishu text message on demand ----
  const tool = defineTool({
    name: 'feishu_send',
    description: 'Send a text message to a Feishu chat through a configured app bot (~/.cc-connect/feishu.config.json). chatId is optional: it defaults to the most recent chat that messaged the bot. appId is optional: it selects which bot to use (defaults to the bot that last received a message).',
    parameters: {
      text: { type: 'string', required: true, description: 'Text content to send.' },
      chatId: { type: 'string', description: 'Target chat id (oc_...). Omit to send to the most recent chat that messaged the bot.' },
      appId: { type: 'string', description: 'Bot app id (cli_...) to send through. Omit to use the bot that most recently received a message.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'number', required: true },
          detail: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: 'text', text: 'feishu_send -> ' + JSON.stringify(value) }],
    },
    async execute(args) {
      const list = await readConfig()
      const appId = typeof args.appId === 'string' && args.appId.length > 0 ? args.appId.trim() : undefined
      let bot
      if (appId) {
        const cfg = list.find((c) => c.appId === appId)
        if (!cfg) return { ok: false, status: 0, detail: '未找到 appId=' + appId + ' 对应的机器人配置' }
        bot = bots.get(appId) || makeBot(cfg)
      } else {
        // default to the bot that most recently received a message
        let best = undefined
        for (const b of bots.values()) {
          if (b.lastChatId && (!best || b.lastChatId > best.lastChatId)) best = b
        }
        if (!best && list.length > 0) {
          best = bots.get(list[0].appId) || makeBot(list[0])
        }
        if (!best) return { ok: false, status: 0, detail: '没有配置任何机器人' }
        bot = best
      }
      const chatId = typeof args.chatId === 'string' && args.chatId.length > 0 ? args.chatId : undefined
      try {
        const res = await sendFeishuText(bot, chatId, String(args.text))
        return { ok: res.status >= 200 && res.status < 300, status: res.status, detail: String(res.text || '').slice(0, 1000) }
      } catch (error) {
        return { ok: false, status: 0, detail: String(error && error.message || error) }
      }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))

  // ---- lifecycle: one effect owns all helper processes and the drain timer ----
  ctx.effect(() => {
    const stopTimer = ctx.interval(() => drainOutput(), 500)
    return () => {
      stopping = true
      for (const bot of bots.values()) {
        try { if (bot.proc) bot.proc.kill() } catch { /* ignore */ }
      }
      bots.clear()
      stopTimer()
    }
  })

  console.log('[feishu] bridge active (static, long-connection mode, multi-bot). config: ' + configPath())
  void ensureHelper()
}
