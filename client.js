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
            const [form, setForm] = React.useState({ workspace: '', appId: '', appSecret: '', hasSecret: false })
            const [connection, setConnection] = React.useState('...')
            const [lastChatId, setLastChatId] = React.useState('')
            const [notice, setNotice] = React.useState('')
            const [busy, setBusy] = React.useState(false)
            const [testText, setTestText] = React.useState('这是一条来自飞书桥接插件的测试消息')
            const [testOut, setTestOut] = React.useState('')

            const refresh = () => {
              admin('status').then((v) => {
                if (!v || typeof v !== 'object') return
                setForm((f) => ({
                  ...f,
                  workspace: typeof v.workspace === 'string' ? v.workspace : '',
                  appId: typeof v.appId === 'string' ? v.appId : '',
                  hasSecret: !!v.hasSecret,
                }))
                setConnection(typeof v.connection === 'string' ? v.connection : 'idle')
                setLastChatId(typeof v.lastChatId === 'string' ? v.lastChatId : '')
              }).catch((e) => {
                setNotice('读取配置失败: ' + String((e && e.message) || e))
              })
            }

            React.useEffect(() => { refresh() }, [])

            const save = () => {
              setBusy(true)
              setNotice('')
              admin('config', { method: 'POST', body: JSON.stringify({
                workspace: form.workspace.trim(),
                appId: form.appId.trim(),
                appSecret: form.appSecret,
              }) }).then((v) => {
                setBusy(false)
                setNotice(String(v.message || (v.ok ? '已保存' : '保存失败')))
                setForm((f) => ({ ...f, appSecret: '' }))
                refresh()
              }).catch((e) => {
                setBusy(false)
                setNotice('保存失败: ' + String((e && e.message) || e))
              })
            }

            const sendTest = () => {
              setBusy(true)
              setTestOut('')
              admin('send-test', { method: 'POST', body: JSON.stringify({ text: testText }) }).then((v) => {
                setBusy(false)
                setTestOut('ok=' + String(v.ok) + ' status=' + String(v.status) + ' ' + String(v.detail || ''))
                refresh()
              }).catch((e) => {
                setBusy(false)
                setTestOut('发送失败: ' + String((e && e.message) || e))
              })
            }

            const rowStyle = { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' }
            const labelStyle = { fontSize: '12px', opacity: 0.75 }
            const inputStyle = { padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', width: '100%', boxSizing: 'border-box' }
            const btnStyle = { padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' }

            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '520px' } },
              h('p', { style: labelStyle }, '配置写入工作区根目录的 feishu.config.json；长连接模式无需公网地址。桥接目标：配置的 workspace 对应的会话。支持 /new /switch /list /help 命令。'),
              h('div', { style: rowStyle },
                h('label', { style: labelStyle }, '工作区路径 (workspace)'),
                h('input', { style: inputStyle, value: form.workspace, placeholder: 'D:\\path\\to\\workspace', onChange: (e) => setForm((f) => ({ ...f, workspace: e.target.value })) }),
              ),
              h('div', { style: rowStyle },
                h('label', { style: labelStyle }, 'App ID'),
                h('input', { style: inputStyle, value: form.appId, placeholder: 'cli_...', onChange: (e) => setForm((f) => ({ ...f, appId: e.target.value })) }),
              ),
              h('div', { style: rowStyle },
                h('label', { style: labelStyle }, 'App Secret'),
                h('input', { style: inputStyle, type: 'password', value: form.appSecret, placeholder: form.hasSecret ? '已配置（留空保持不变）' : '请输入 App Secret', onChange: (e) => setForm((f) => ({ ...f, appSecret: e.target.value })) }),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } },
                h('span', { style: { fontSize: '12px' } }, '连接状态: ' + connection),
                h('button', { style: btnStyle, onClick: refresh, disabled: busy }, '刷新'),
              ),
              h('div', { style: { display: 'flex', gap: '10px', marginBottom: '12px' } },
                h('button', { style: btnStyle, onClick: save, disabled: busy }, busy ? '处理中...' : '保存配置'),
              ),
              notice ? h('div', { style: { fontSize: '12px', marginBottom: '12px', wordBreak: 'break-all' } }, notice) : null,
              h('hr', { style: { border: 'none', borderTop: '1px solid rgba(128,128,128,0.25)', margin: '8px 0 12px' } }),
              h('div', { style: rowStyle },
                h('label', { style: labelStyle }, '测试内容'),
                h('input', { style: inputStyle, value: testText, onChange: (e) => setTestText(e.target.value) }),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } },
                h('button', { style: btnStyle, onClick: sendTest, disabled: busy }, '发送测试消息'),
                lastChatId ? h('span', { style: { fontSize: '12px', opacity: 0.75 } }, '将发送到最近会话: ' + lastChatId) : null,
              ),
              testOut ? h('div', { style: { fontSize: '12px', wordBreak: 'break-all' } }, testOut) : null,
            )
          },
        ))
      },
    }
  },
})
