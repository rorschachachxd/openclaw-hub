/**
 * server.js — Dialogue Server 主入口
 *
 * 路由：
 *   GET  /              → 提供 public/ 静态文件
 *   GET  /config        → 返回当前配置
 *   POST /config        → 保存配置
 *   POST /test          → 连通性测试
 *   GET  /events        → SSE 端点（token 流推送到浏览器）
 *   POST /chat          → 发送用户消息，启动或插入对话
 *   POST /stop          → 停止当前对话
 */

import express from 'express'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { AgentClient } from './agent-client.js'
import { Session } from './session.js'

const __dir    = dirname(fileURLToPath(import.meta.url))
const CFG_FILE = join(__dir, 'config.json')
const PORT     = process.env.PORT || 3000

// ── 全局状态 ──────────────────────────────────────────────────────────────────

let config  = loadConfig()
let session = new Session()
let clients = []          // SSE 连接列表

let agentA = null
let agentB = null
rebuildClients()

// ── Express ───────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(express.static(join(__dir, 'public')))

// ── /config ───────────────────────────────────────────────────────────────────

app.get('/config', (_req, res) => {
  res.json(config)
})

app.post('/config', (req, res) => {
  const { agentA: a, agentB: b, maxRounds } = req.body
  config = { agentA: a, agentB: b, maxRounds: parseInt(maxRounds) || 10 }
  saveConfig(config)
  rebuildClients()
  res.json({ ok: true })
})

// ── /test  (连通性测试) ────────────────────────────────────────────────────────

app.post('/test', async (req, res) => {
  const { which } = req.body   // 'A' | 'B' | 'all'
  const results = {}

  const test = async (label, client) => {
    try {
      const r = await client.probe()
      results[label] = r
    } catch (e) {
      results[label] = { ok: false, error: e.message }
    }
  }

  if (which === 'B') {
    await test('B', agentB)
  } else if (which === 'A') {
    await test('A', agentA)
  } else {
    await Promise.all([test('A', agentA), test('B', agentB)])
  }

  res.json(results)
})

// ── /events  (SSE) ────────────────────────────────────────────────────────────

app.get('/events', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',   // 禁止 nginx 缓冲，确保 token 实时到达
  })
  res.flushHeaders()

  // 发送一次心跳确认连接
  res.write('data: {"type":"connected"}\n\n')

  const client = { res }
  clients.push(client)

  req.on('close', () => {
    clients = clients.filter(c => c !== client)
  })
})

// ── /chat ─────────────────────────────────────────────────────────────────────

app.post('/chat', async (req, res) => {
  const { message } = req.body
  if (!message?.trim()) return res.status(400).json({ error: '消息不能为空' })

  res.json({ ok: true })

  if (session.isRunning()) {
    // 对话进行中 → 排队插入
    session.injectMessage(message.trim())
    broadcast({ type: 'user-injected', content: message.trim() })
    return
  }

  // 启动新轮次
  session.reset()
  session.setMaxRounds(config.maxRounds)
  session.start()
  session.addUserMessage(message.trim())
  broadcast({ type: 'user', content: message.trim() })

  runConversation().catch(err => {
    console.error('[conversation error]', err)
    broadcast({ type: 'error', content: err.message })
  })
})

// ── /stop ─────────────────────────────────────────────────────────────────────

app.post('/stop', (_req, res) => {
  session.stop()
  broadcast({ type: 'stopped' })
  res.json({ ok: true })
})

// ── 对话调度核心 ───────────────────────────────────────────────────────────────

async function runConversation() {
  const signal = session.abortController?.signal

  try {
    while (!session.isDone()) {
      // ── Agent A 发言 ──────────────────────────────────────────────────────
      broadcast({ type: 'agent-start', agent: 'A' })
      let replyA = ''

      try {
        replyA = await agentA.chat(
          session.buildMessagesForA(config.agentA?.persona),
          (token) => broadcast({ type: 'token', agent: 'A', token }),
          signal,
        )
      } catch (e) {
        if (signal?.aborted) break
        broadcast({ type: 'agent-error', agent: 'A', content: e.message })
        break
      }

      session.addAgentAReply(replyA)
      broadcast({ type: 'agent-done', agent: 'A', content: replyA })

      if (session.isDone()) break

      // 检查是否有用户插入消息
      const pending = session.consumePending()
      if (pending) {
        session.addUserMessage(pending)
        broadcast({ type: 'user', content: pending })
      }

      // ── Agent B 发言 ──────────────────────────────────────────────────────
      broadcast({ type: 'agent-start', agent: 'B' })
      let replyB = ''

      try {
        replyB = await agentB.chat(
          session.buildMessagesForB(config.agentB?.persona),
          (token) => broadcast({ type: 'token', agent: 'B', token }),
          signal,
        )
      } catch (e) {
        if (signal?.aborted) break
        broadcast({ type: 'agent-error', agent: 'B', content: e.message })
        break
      }

      session.addAgentBReply(replyB)
      broadcast({ type: 'agent-done', agent: 'B', content: replyB })

      // 推进轮次
      if (!session.nextRound()) break
    }
  } finally {
    if (!session.isDone()) session.state = 'done'
    broadcast({ type: 'done', rounds: session.round })
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const c of clients) {
    try { c.res.write(payload) } catch (_) {}
  }
}

function rebuildClients() {
  const a = config.agentA || {}
  const b = config.agentB || {}
  agentA = new AgentClient({ ip: a.ip || '127.0.0.1', port: a.port || 18789, token: a.token || '', relayPort: a.relayPort || 3001, agentId: a.agentId || 'main' })
  agentB = new AgentClient({ ip: b.ip || '127.0.0.1', port: b.port || 18789, token: b.token || '', relayPort: b.relayPort || 3001, agentId: b.agentId || 'main' })
}

function loadConfig() {
  if (existsSync(CFG_FILE)) {
    try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')) } catch (_) {}
  }
  return {
    agentA: { ip: '127.0.0.1', port: 18789, token: '', persona: '', relayPort: 3001, agentId: 'main' },
    agentB: { ip: '127.0.0.1', port: 18789, token: '', persona: '', relayPort: 3001, agentId: 'main' },
    maxRounds: 10,
  }
}

function saveConfig(cfg) {
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nOpenClaw Hub running → http://localhost:${PORT}\n`)
})
