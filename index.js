// dsh-feishu-connect — host plugin (node half).
// Bridges Feishu (Lark) chats with the configured workspace's agent conversation
// via the official SDK long connection (helper.js subprocess), with cc-connect-style
// commands (/new /switch /list /help), per-chat sessions, a typing reaction,
// markdown cards, and same-origin admin routes used by the settings-page bundle.

import { fileURLToPath } from 'node:url'
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
  const seen = new Set()          // Feishu message ids already handled (dedupe)
  const MAX_SEEN = 500
  let chain = Promise.resolve()   // serializes inbound processing
  let token = undefined           // cached tenant_access_token
  let tokenExpiresAt = 0
  let proc = undefined            // helper ShellProcess
  let procKey = ''                // appId|appSecret|workspace the helper runs with
  let lastSpawnAt = 0
  let lastConfigCheck = 0
  let lastStatus = ''
  let lastChatId = ''             // most recent Feishu chat a user messaged the bot from
  let stopping = false
  const chats = new Map()         // chatId -> { sessions: [], activeIndex }
  let stateCache = undefined      // loaded .dsh-feishu/state.json content

  // ---- config: <workspaceRoot>/feishu.config.json, re-read periodically ----
  const workspaceRoot = () => {
    const sp = ctx.get('sandboxPolicy')
    return sp && typeof sp.workspaceRoot === 'string' ? sp.workspaceRoot : undefined
  }

  async function readConfig() {
    try {
      const root = workspaceRoot()
      if (!root) return {}
      const target = await ctx.fs.resolve('feishu.config.json', { cwd: root })
      const text = await ctx.fs.readText(target)
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  async function writeConfig(cfg) {
    const root = workspaceRoot()
    if (!root) throw new Error('workspace root unavailable')
    const target = await ctx.fs.resolve('feishu.config.json', { cwd: root })
    await ctx.fs.writeText(target, JSON.stringify(cfg, null, 2))
  }

  // ---- path helpers ----
  const normalizePath = (p) => {
    if (typeof p !== 'string' || p.length === 0) return ''
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  function helperDir(cfg) {
    const ws = (cfg.workspace && String(cfg.workspace).trim()) || workspaceRoot() || ''
    return ws.replace(/[\\/]+$/, '') + '/.dsh-feishu'
  }

  // ---- per-chat session state persistence (.dsh-feishu/state.json) ----
  async function loadState(cfg) {
    if (stateCache !== undefined) return stateCache
    stateCache = { chats: {} }
    try {
      const target = await ctx.fs.resolve('state.json', { cwd: helperDir(cfg) })
      const text = await ctx.fs.readText(target)
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object') {
        stateCache = parsed
      }
    } catch {
      // first run: no state file yet
    }
    return stateCache
  }

  async function saveState(cfg) {
    try {
      const target = await ctx.fs.resolve('state.json', { cwd: helperDir(cfg) })
      await ctx.fs.writeText(target, JSON.stringify(stateCache || { chats: {} }, null, 2))
    } catch (error) {
      console.log('[feishu] state save failed: ' + String(error && error.message || error))
    }
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
  async function tenantAccessToken(appId, appSecret) {
    const now = Date.now()
    if (token && tokenExpiresAt > now + 60000) return token
    const res = await httpJson(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      'POST',
      { 'Content-Type': 'application/json' },
      { app_id: appId, app_secret: appSecret },
    )
    const parsed = parseJsonObject(res.text)
    if (parsed && parsed.code === 0 && typeof parsed.tenant_access_token === 'string') {
      token = parsed.tenant_access_token
      tokenExpiresAt = now + (Number(parsed.expire) || 7200) * 1000
      return token
    }
    throw new Error('tenant_access_token failed: ' + (res.text || JSON.stringify(res)))
  }

  async function sendAppMessage(appId, appSecret, chatId, text) {
    const accessToken = await tenantAccessToken(appId, appSecret)
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content: text }],
    }
    return httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      'POST',
      { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    )
  }

  async function sendFeishuText(cfg, chatId, text) {
    const hasCreds = typeof cfg.appId === 'string' && cfg.appId.length > 0
      && typeof cfg.appSecret === 'string' && cfg.appSecret.length > 0
    if (!hasCreds) {
      return { status: 0, text: '未配置 appId/appSecret：请到 设置 → 飞书机器人 填写并保存' }
    }
    const target = chatId || lastChatId || ''
    if (!target) {
      return { status: 0, text: '没有可用的 chat_id：先在飞书里给机器人发一条消息（插件会自动记录该会话），或手动填写 chat_id' }
    }
    return sendAppMessage(cfg.appId, cfg.appSecret, target, text)
  }

  // ---- typing reaction (cc-connect StartTyping): added on arrival, removed
  //      only AFTER the reply is delivered (EventResult-then-stop order) ----
  async function addReaction(appId, appSecret, messageId, emoji) {
    const accessToken = await tenantAccessToken(appId, appSecret)
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

  async function removeReaction(appId, appSecret, messageId, reactionId) {
    const accessToken = await tenantAccessToken(appId, appSecret)
    return httpJson(
      'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId)
        + '/reactions/' + encodeURIComponent(reactionId),
      'DELETE',
      { Authorization: 'Bearer ' + accessToken },
      undefined,
    )
  }

  // ---- agent selection: the live agent whose session belongs to the configured workspace ----
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
  // Shared model selection for created and resumed dedicated agents: both
  // paths must install options.model, or prompt variables like {{model}}
  // have no value and the first turn fails at assembly.
  const defaultAgentOptions = () => {
    const selection = ctx.get('agentDefaultModel')
    const selected = selection && typeof selection.currentSelection === 'function'
      ? selection.currentSelection() : undefined
    return selected ? { provider: selected.provider, model: selected.model } : undefined
  }

  async function createDedicated(cfg, sessionId, mainAgent) {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents service unavailable')
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

  async function resumeDedicated(cfg, sessionId, mainAgent) {
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

  async function ensureChat(cfg, chatId) {
    const existing = chats.get(chatId)
    if (existing) return existing
    const state = await loadState(cfg)
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
    chats.set(chatId, chat)
    return chat
  }

  async function persistChat(cfg, chatId, chat) {
    const state = await loadState(cfg)
    if (!state.chats) state.chats = {}
    state.chats[chatId] = {
      sessions: chat.sessions.map((s) => ({ id: s.id, label: s.label, type: s.type })),
      active: chat.sessions[chat.activeIndex] ? chat.sessions[chat.activeIndex].id : (chat.sessions[0] ? chat.sessions[0].id : 'main'),
    }
    await saveState(cfg)
  }

  async function resolveActiveAgent(cfg, chat, mainAgent) {
    const entry = chat.sessions[chat.activeIndex]
    if (!entry) return undefined
    if (entry.type === 'main') return mainAgent
    if (entry.handle) return entry.handle.agent
    try {
      const handle = await resumeDedicated(cfg, entry.id, mainAgent)
      entry.handle = handle
      return handle.agent
    } catch (error) {
      console.log('[feishu] resume failed for ' + entry.id + ': ' + String(error && error.message || error))
      return undefined
    }
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

  async function handleCommand(cfg, chatId, cmdLine) {
    const parts = String(cmdLine).trim().split(/\s+/)
    const rawName = (parts[0] || '').toLowerCase()
    const name = resolveCommand(rawName.startsWith('/') ? rawName.slice(1) : rawName)
    if (!name) {
      await sendFeishuText(cfg, chatId, '未知命令 `' + parts[0] + '`，发送 /help 查看可用命令。')
      return
    }
    const chat = await ensureChat(cfg, chatId)
    const mainAgent = pickAgent(cfg.workspace)

    if (name === 'help') {
      await sendFeishuText(cfg, chatId, HELP_TEXT)
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
      await sendFeishuText(cfg, chatId, lines.join('\n'))
      return
    }
    if (name === 'new') {
      const label = parts.slice(1).join(' ').trim() || ('会话 ' + (chat.sessions.length + 1))
      try {
        const sessionId = chatSessionId(chatId, chat.sessions.length)
        const handle = await createDedicated(cfg, sessionId, mainAgent)
        chat.sessions.push({ id: sessionId, label, type: 'dedicated', handle })
        chat.activeIndex = chat.sessions.length - 1
        await persistChat(cfg, chatId, chat)
        await sendFeishuText(cfg, chatId, '已创建独立会话 **' + label + '** 并切换。\n\n之后的消息将进入新会话；/switch 1 可回到主会话。')
      } catch (error) {
        console.log('[feishu] /new failed: ' + String(error && error.stack || error))
        await sendFeishuText(cfg, chatId, '创建会话失败：' + String(error && error.message || error))
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
        await sendFeishuText(cfg, chatId, lines.join('\n'))
        return
      }
      const index = Number(arg)
      if (!Number.isInteger(index) || index < 1 || index > chat.sessions.length) {
        await sendFeishuText(cfg, chatId, '无效序号：`' + arg + '`。发送 /list 查看可用会话。')
        return
      }
      chat.activeIndex = index - 1
      await persistChat(cfg, chatId, chat)
      const entry = chat.sessions[chat.activeIndex]
      await sendFeishuText(cfg, chatId, '已切换到 **' + entry.label + '**' + (entry.type === 'dedicated' ? '（独立会话）' : '（主会话）') + '。')
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

  async function handleFeishuMessage(evt) {
    const cfg = await readConfig()
    const messageId = evt.message_id
    if (typeof messageId !== 'string' || messageId.length === 0) return
    if (evt.chat_id) lastChatId = evt.chat_id
    if (seen.has(messageId)) return // redelivery guard
    if (seen.size > MAX_SEEN) seen.clear()
    seen.add(messageId)

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
      await handleCommand(cfg, chatId, text)
      return
    }

    const mainAgent = pickAgent(cfg.workspace)
    const chat = await ensureChat(cfg, chatId)
    const agent = await resolveActiveAgent(cfg, chat, mainAgent)
    if (!agent) {
      await sendFeishuText(cfg, chatId, '当前没有可用的 Agent 会话：配置的工作区（'
        + (cfg.workspace || workspaceRoot() || '?') + '）没有打开的会话，或会话恢复失败。发送 /list 查看可用会话。')
      return
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
      void removeReaction(cfg.appId, cfg.appSecret, messageId, reactionId).catch((error) => {
        console.log('[feishu] reaction remove failed: ' + String(error && error.message || error))
      })
    }
    if (typingEnabled) {
      try {
        const r = await addReaction(cfg.appId, cfg.appSecret, messageId, emoji)
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
      const res = await sendFeishuText(cfg, chatId, reply)
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

  function handleHelperMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'event' && msg.eventType === 'im.message.receive_v1') {
      const evt = normalizeEvent(msg.data)
      chain = chain.then(() => handleFeishuMessage(evt)).catch((error) => {
        console.log('[feishu] handler error: ' + String(error && error.stack || error))
      })
      return
    }
    if (msg.type === 'ready') {
      lastStatus = 'connected'
      console.log('[feishu] WebSocket long connection ready')
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
      if (line !== lastStatus) {
        lastStatus = line
        console.log('[feishu] connection status: ' + line)
      }
      return
    }
  }

  // ---- helper process lifecycle ----
  function quoteArg(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }

  function spawnHelper(cfg) {
    const appId = cfg.appId && String(cfg.appId).trim()
    const appSecret = cfg.appSecret && String(cfg.appSecret).trim()
    if (!appId || !appSecret) return
    const key = appId + '|' + appSecret + '|' + String(cfg.workspace || '')
    if (proc && proc.status === 'running' && procKey === key) return
    lastSpawnAt = Date.now()
    if (proc) {
      try { proc.kill() } catch { /* ignore */ }
    }
    const spec = ctx.shell.resolve({
      command: 'node ' + quoteArg(HELPER_PATH) + ' ' + quoteArg(appId) + ' ' + quoteArg(appSecret),
    })
    proc = ctx.shell.start(spec)
    procKey = key
    console.log('[feishu] helper spawned (app ' + appId + ')')
  }

  async function ensureHelper() {
    const now = Date.now()
    if (stopping) return
    if (now - lastConfigCheck < 10000) {
      if (proc && proc.status === 'running') return
      if (now - lastSpawnAt < 5000) return
      const cfg = await readConfig()
      spawnHelper(cfg)
      return
    }
    lastConfigCheck = now
    const cfg = await readConfig()
    const appId = cfg.appId && String(cfg.appId).trim()
    const appSecret = cfg.appSecret && String(cfg.appSecret).trim()
    const key = appId + '|' + appSecret + '|' + String(cfg.workspace || '')
    if (!appId || !appSecret) {
      if (proc && proc.status === 'running') {
        console.log('[feishu] config cleared; stopping helper')
        try { proc.kill() } catch { /* ignore */ }
        proc = undefined
      }
      return
    }
    if (proc && proc.status === 'running' && procKey === key) return
    spawnHelper(cfg)
  }

  function drainOutput() {
    if (!proc) return
    try {
      const read = proc.readOutput()
      if (read && read.delta) {
        for (const line of read.delta.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let msg
          try { msg = JSON.parse(trimmed) } catch { continue }
          handleHelperMessage(msg)
        }
      }
    } catch (error) {
      console.log('[feishu] poll error: ' + String(error && error.message || error))
    }
    void ensureHelper()
  }

  function connectionLabel() {
    if (lastStatus) return lastStatus
    if (proc && proc.status === 'running') return 'connecting'
    return 'idle'
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

  async function handleAdminStatus(res) {
    const cfg = await readConfig()
    respondJson(res, 200, {
      workspace: typeof cfg.workspace === 'string' ? cfg.workspace : workspaceRoot() || '',
      appId: typeof cfg.appId === 'string' ? cfg.appId : '',
      hasSecret: !!(cfg.appSecret && String(cfg.appSecret).length > 0),
      connection: connectionLabel(),
      helperRunning: !!(proc && proc.status === 'running'),
      lastChatId,
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
    const next = {
      workspace: body && typeof body.workspace === 'string' ? body.workspace.trim() : (current.workspace || ''),
      appId: body && typeof body.appId === 'string' ? body.appId.trim() : (current.appId || ''),
      appSecret: body && typeof body.appSecret === 'string' && body.appSecret.trim().length > 0
        ? body.appSecret.trim()
        : (current.appSecret || ''),
    }
    try {
      await writeConfig(next)
      lastConfigCheck = 0
      void ensureHelper()
      respondJson(res, 200, { ok: true, message: '配置已保存到 ' + (workspaceRoot() || '?') + '/feishu.config.json' })
    } catch (error) {
      respondJson(res, 500, { ok: false, message: '保存失败: ' + String(error && error.message || error) })
    }
  }

  async function handleAdminSendTest(req, res) {
    const cfg = await readConfig()
    let body = {}
    try {
      body = JSON.parse(await readBody(req, 65536)) || {}
    } catch {
      respondJson(res, 400, { ok: false, status: 0, detail: 'invalid json body' })
      return
    }
    const chatId = typeof body.chatId === 'string' && body.chatId.length > 0 ? body.chatId : undefined
    const text = typeof body.text === 'string' && body.text.length > 0 ? body.text : '测试消息'
    try {
      const result = await sendFeishuText(cfg, chatId, text)
      respondJson(res, 200, {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        detail: String(result.text || '').slice(0, 1000),
      })
    } catch (error) {
      respondJson(res, 200, { ok: false, status: 0, detail: String(error && error.message || error) })
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
    path: '/feishu/admin/send-test',
    handler: (req, res) => {
      if (req.method !== 'POST') return respondJson(res, 405, { ok: false, message: 'method not allowed' })
      void handleAdminSendTest(req, res)
    },
  }))

  // ---- model tool: send a Feishu text message on demand ----
  const tool = defineTool({
    name: 'feishu_send',
    description: 'Send a text message to a Feishu chat through the configured app bot (feishu.config.json appId/appSecret). chatId is optional: it defaults to the most recent chat that messaged the bot.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text content to send.' },
      chatId: { type: 'string', description: 'Target chat id (oc_...). Omit to send to the most recent chat that messaged the bot.' },
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
      const cfg = await readConfig()
      const chatId = typeof args.chatId === 'string' && args.chatId.length > 0 ? args.chatId : undefined
      try {
        const res = await sendFeishuText(cfg, chatId, String(args.text))
        return { ok: res.status >= 200 && res.status < 300, status: res.status, detail: String(res.text || '').slice(0, 1000) }
      } catch (error) {
        return { ok: false, status: 0, detail: String(error && error.message || error) }
      }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))

  // ---- lifecycle: one effect owns the helper process and the poll timer ----
  ctx.effect(() => {
    const stopTimer = ctx.interval(() => drainOutput(), 500)
    return () => {
      stopping = true
      try { if (proc) proc.kill() } catch { /* ignore */ }
      stopTimer()
    }
  })

  console.log('[feishu] bridge active (static, long-connection mode). config: '
    + (workspaceRoot() || '?') + '/feishu.config.json')
  void ensureHelper()
}
