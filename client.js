// dsh-feishu-connect — browser bundle, hand-authored in the exact artifact
// format tsdown emits for client packages: a closure factory registered through
// window.__ModuleLoader__.load({ id, factory }), with platform modules (react)
// resolved through the injected require (the shell's frozen module table).
// RPC to the host goes through same-origin admin routes on the web server.
window.__ModuleLoader__.load({
  id: 'dsh-feishu-connect',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    return {
      name: 'dsh-feishu-connect',
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return

        const admin = async (path, init) => {
          const response = await globalThis.fetch('/feishu/admin/' + path, {
            ...init,
            headers: { 'Content-Type': 'application/json', ...(init && init.headers ? init.headers : {}) },
          })
          let value = {}
          try { value = await response.json() } catch { /* non-json */ }
          return value
        }

        slots.inject('settings.section', () => slots.register(
          {
            name: 'settings.section',
            id: 'feishu-bridge',
            order: 25,
            label: '飞书机器人',
          },
          () => {
            const [bots, setBots] = React.useState([])
            const [notice, setNotice] = React.useState('')
            const [busy, setBusy] = React.useState(false)
            const [editing, setEditing] = React.useState(null)     // appId being edited
            const [draft, setDraft] = React.useState({ name: '', workspace: '', appId: '', appSecret: '' })
            const [scan, setScan] = React.useState({ active: false, appId: '', qrDataUrl: '', userCode: '', deviceCode: '', error: '', done: false })
            const scanTimer = React.useRef(null)
            const [testOut, setTestOut] = React.useState('')

            const refresh = () => {
              admin('status').then((v) => {
                if (!v || !Array.isArray(v.bots)) return
                setBots(v.bots)
              }).catch((e) => {
                setNotice('读取配置失败: ' + String((e && e.message) || e))
              })
            }

            React.useEffect(() => { refresh() }, [])

            const saveBots = (list, done) => {
              setBusy(true)
              setNotice('')
              admin('config', { method: 'POST', body: JSON.stringify({ bots: list }) }).then((v) => {
                setBusy(false)
                setNotice(String(v.message || (v.ok ? '已保存' : '保存失败')))
                refresh()
                if (done) done()
              }).catch((e) => {
                setBusy(false)
                setNotice('保存失败: ' + String((e && e.message) || e))
              })
            }

            const startEdit = (bot) => {
              setEditing(bot ? bot.appId : '__new__')
              setDraft({
                name: bot ? bot.name : '',
                workspace: bot ? bot.workspace : '',
                appId: bot ? bot.appId : '',
                appSecret: '',
                hasSecret: bot ? !!bot.hasSecret : false,
              })
              setTestOut('')
            }

            const cancelEdit = () => {
              setEditing(null)
              setDraft({ name: '', workspace: '', appId: '', appSecret: '', hasSecret: false })
            }

            const submitEdit = () => {
              const appId = draft.appId.trim()
              if (!appId) { setNotice('App ID 不能为空'); return }
              const existing = bots.find((b) => b.appId === appId)
              const entry = {
                name: draft.name.trim() || appId,
                workspace: draft.workspace.trim(),
                appId,
                appSecret: draft.appSecret.trim(),
              }
              let next
              if (existing) {
                // keep the stored secret unless a new one was typed
                next = bots.map((b) => b.appId === appId ? { ...b, ...entry, appSecret: entry.appSecret || b.appSecret } : b)
              } else {
                // new bot: a secret is required (scan-to-create already saved one,
                // so a fresh manual add must not silently save without a secret)
                if (!entry.appSecret) {
                  setNotice('新机器人需要填写 App Secret（扫码创建的机器人已自动保存，无需再填）')
                  return
                }
                next = [...bots, entry]
              }
              saveBots(next, () => cancelEdit())
            }

            const removeBot = (appId) => {
              if (!globalThis.confirm('确定删除机器人 ' + appId + '？')) return
              setBusy(true)
              admin('delete-bot', { method: 'POST', body: JSON.stringify({ appId }) }).then((v) => {
                setBusy(false)
                setNotice(String(v.message || (v.ok ? '已删除' : '删除失败')))
                refresh()
              }).catch((e) => {
                setBusy(false)
                setNotice('删除失败: ' + String((e && e.message) || e))
              })
            }

            // ---- scan-to-create robot (Feishu official app-registration device flow) ----
            const startScan = () => {
              setScan({ active: true, appId: '', qrDataUrl: '', userCode: '', deviceCode: '', error: '', done: false })
              admin('onboard', { method: 'POST', body: '{}' }).then((v) => {
                if (!v || !v.ok) throw new Error(String((v && v.message) || '生成二维码失败'))
                setScan((s) => ({
                  ...s,
                  qrDataUrl: typeof v.qrDataUrl === 'string' ? v.qrDataUrl : '',
                  userCode: typeof v.userCode === 'string' ? v.userCode : '',
                  deviceCode: typeof v.deviceCode === 'string' ? v.deviceCode : '',
                }))
                const intervalMs = (typeof v.interval === 'number' && v.interval > 0 ? v.interval : 5) * 1000
                if (scanTimer.current) clearInterval(scanTimer.current)
                scanTimer.current = setInterval(() => {
                  const code = typeof v.deviceCode === 'string' ? v.deviceCode : ''
                  if (!code) return
                  admin('onboard/poll', { method: 'POST', body: JSON.stringify({ deviceCode: code }) }).then((p) => {
                    if (p && p.done && typeof p.appId === 'string' && typeof p.appSecret === 'string') {
                      if (scanTimer.current) { clearInterval(scanTimer.current); scanTimer.current = null }
                      // close the QR immediately on successful scan; the bot is
                      // saved in the background
                      setScan({ active: false, appId: '', qrDataUrl: '', userCode: '', deviceCode: '', error: '', done: true })
                      admin('config', { method: 'POST', body: JSON.stringify({
                        appId: p.appId,
                        appSecret: p.appSecret,
                        ownerOpenId: typeof p.ownerOpenId === 'string' ? p.ownerOpenId : '',
                        workspace: '',
                        name: '机器人 ' + p.appId,
                      }) }).then(() => {
                        setNotice('✅ 扫码成功！机器人 ' + p.appId + ' 已添加，App Secret 已自动保存。请点该机器人的「编辑」填写工作区路径。')
                        refresh()
                      }).catch((e) => {
                        setNotice('扫码成功，但自动保存失败: ' + String((e && e.message) || e))
                      })
                    } else if (p && p.error) {
                      if (scanTimer.current) { clearInterval(scanTimer.current); scanTimer.current = null }
                      setScan((s) => ({ ...s, error: String(p.message || p.error) }))
                    }
                  }).catch((e) => {
                    if (scanTimer.current) { clearInterval(scanTimer.current); scanTimer.current = null }
                    setScan((s) => ({ ...s, error: '轮询失败: ' + String((e && e.message) || e) }))
                  })
                }, intervalMs)
              }).catch((e) => {
                setScan((s) => ({ ...s, error: String((e && e.message) || e) }))
              })
            }

            const stopScan = () => {
              if (scanTimer.current) { clearInterval(scanTimer.current); scanTimer.current = null }
              setScan({ active: false, appId: '', qrDataUrl: '', userCode: '', deviceCode: '', error: '', done: false })
            }

            const sendTest = (bot) => {
              setBusy(true)
              setTestOut('')
              admin('send-test', { method: 'POST', body: JSON.stringify({ appId: bot.appId, text: '这是一条来自飞书桥接插件的测试消息' }) }).then((v) => {
                setBusy(false)
                setTestOut(bot.appId + ': ok=' + String(v.ok) + ' status=' + String(v.status) + ' ' + String(v.detail || ''))
              }).catch((e) => {
                setBusy(false)
                setTestOut(bot.appId + ': 发送失败: ' + String((e && e.message) || e))
              })
            }

            const toggleBot = (bot) => {
              setBusy(true)
              setNotice('')
              admin('toggle', { method: 'POST', body: JSON.stringify({ appId: bot.appId }) }).then((v) => {
                setBusy(false)
                setNotice(String(v.message || (v.ok ? '已切换' : '切换失败')))
                refresh()
              }).catch((e) => {
                setBusy(false)
                setNotice('切换失败: ' + String((e && e.message) || e))
              })
            }

            const rowStyle = { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }
            const labelStyle = { fontSize: '12px', opacity: 0.75 }
            const inputStyle = { padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', width: '100%', boxSizing: 'border-box' }
            const btnStyle = { padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' }
            const cardStyle = { border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px', padding: '12px', marginBottom: '12px' }

            const input = (field, placeholder, type) =>
              h('input', { style: inputStyle, type: type || 'text', value: draft[field], placeholder, onChange: (e) => setDraft((d) => ({ ...d, [field]: e.target.value })) })

            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '640px' } },
              h('p', { style: labelStyle }, '配置写入 ~/.cc-connect/feishu.config.json；长连接模式无需公网地址。每个机器人绑定一个工作区（workspace），其消息进入该工作区的 Agent 会话。支持 /new /switch /list /help 命令。'),

              // ---- bot list ----
              bots.length === 0 && editing === null
                ? h('div', { style: { ...cardStyle, textAlign: 'center', color: 'rgba(128,128,128,0.8)' } },
                    h('p', { style: { margin: '0 0 10px', fontSize: '13px' } }, '尚未配置任何机器人'),
                    h('button', { style: btnStyle, onClick: () => startEdit(null) }, '手动添加'),
                    h('span', { style: { margin: '0 8px', opacity: 0.6 } }, '或'),
                    h('button', { style: btnStyle, onClick: startScan }, '扫码创建'),
                  )
                : null,

              bots.map((bot) =>
                h('div', { key: bot.appId, style: cardStyle },
                  h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
                    h('span', { style: { fontWeight: 600, fontSize: '13px' } }, bot.name || bot.appId),
                    h('span', { style: { fontSize: '12px' } },
                      bot.enabled === false ? '已停用' : ('连接状态: ' + bot.connection)),
                  ),
                  h('div', { style: { fontSize: '12px', marginBottom: '6px', wordBreak: 'break-all', opacity: 0.8 } },
                    'AppID: ' + bot.appId + ' | 工作区: ' + (bot.workspace || '（未设置）') + (bot.hasSecret ? '' : ' | ⚠️ 未配置 Secret'),
                  ),
                  bot.lastChatId ? h('div', { style: { fontSize: '12px', marginBottom: '6px', opacity: 0.6 } }, '最近会话: ' + bot.lastChatId) : null,
                  h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
                    h('button', { style: { ...btnStyle, ...(bot.enabled === false ? { borderColor: 'rgba(229,83,75,0.6)', color: '#e5534b' } : {}) }, onClick: () => toggleBot(bot), disabled: busy }, bot.enabled === false ? '启用连接' : '停用连接'),
                    h('button', { style: btnStyle, onClick: () => startEdit(bot) }, '编辑'),
                    h('button', { style: btnStyle, onClick: () => sendTest(bot), disabled: busy }, '测试发送'),
                    h('button', { style: { ...btnStyle, color: '#e5534b' }, onClick: () => removeBot(bot.appId) }, '删除'),
                  ),
                ),
              ),

              // ---- add button when list exists ----
              bots.length > 0 && editing === null
                ? h('div', { style: { display: 'flex', gap: '10px', marginBottom: '12px' } },
                    h('button', { style: btnStyle, onClick: () => startEdit(null) }, '+ 添加机器人'),
                    h('button', { style: btnStyle, onClick: startScan }, '扫码创建'),
                  )
                : null,

              // ---- scan card ----
              scan.active
                ? h('div', { style: cardStyle },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
                      h('span', { style: { fontSize: '12px' } }, '请用飞书 App 扫码创建机器人（有效期约 1 小时）'),
                      h('button', { style: btnStyle, onClick: stopScan }, '取消'),
                    ),
                    scan.qrDataUrl ? h('img', { src: scan.qrDataUrl, alt: '扫码创建机器人', style: { width: '220px', height: '220px', marginBottom: '8px', border: '1px solid rgba(128,128,128,0.35)', borderRadius: '6px' } }) : null,
                    scan.userCode ? h('div', { style: { fontSize: '12px', marginBottom: '8px' } }, '验证码: ' + scan.userCode + '（也可在飞书里输入）') : null,
                    scan.error ? h('div', { style: { fontSize: '12px', color: '#e5534b', marginBottom: '8px', wordBreak: 'break-all' } }, scan.error) : null,
                    scan.done ? h('div', { style: { fontSize: '12px', marginBottom: '8px' } }, '✅ 扫码成功，正在添加机器人...') : null,
                  )
                : null,

              // ---- edit form ----
              editing !== null
                ? h('div', { style: cardStyle },
                    h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' } }, editing === '__new__' ? '添加机器人' : '编辑机器人 ' + editing),
                    h('div', { style: rowStyle },
                      h('label', { style: labelStyle }, '名称 (name)'),
                      input('name', '如：运维机器人'),
                    ),
                    h('div', { style: rowStyle },
                      h('label', { style: labelStyle }, '工作区路径 (workspace)'),
                      input('workspace', 'D:\\path\\to\\workspace'),
                    ),
                    h('div', { style: rowStyle },
                      h('label', { style: labelStyle }, 'App ID'),
                      input('appId', 'cli_...'),
                    ),
                    h('div', { style: rowStyle },
                      h('label', { style: labelStyle }, 'App Secret' + (draft.hasSecret ? '（已配置，留空保持不变）' : '')),
                      input('appSecret', draft.hasSecret ? '已配置，留空保持不变' : '请输入 App Secret', 'password'),
                    ),
                    h('div', { style: { display: 'flex', gap: '10px' } },
                      h('button', { style: btnStyle, onClick: submitEdit, disabled: busy }, busy ? '处理中...' : '保存'),
                      h('button', { style: btnStyle, onClick: cancelEdit }, '取消'),
                    ),
                  )
                : null,

              notice ? h('div', { style: { fontSize: '12px', marginBottom: '12px', wordBreak: 'break-all' } }, notice) : null,
              testOut ? h('div', { style: { fontSize: '12px', wordBreak: 'break-all' } }, testOut) : null,
            )
          },
        ))
      },
    }
  },
})
