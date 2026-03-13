/**
 * agent-client.js — OpenClaw Gateway WebSocket 客户端（真实流式输出）
 *
 * 通过 WebSocket 直接连接本机或远端 OpenClaw Gateway，
 * 使用 chat.send RPC 发送消息，实时接收 delta token 流。
 *
 * 协议：
 *   1. Gateway 发 connect.challenge (nonce)
 *   2. 客户端发 req/connect + token 认证
 *   3. 客户端发 req/chat.send + message
 *   4. Gateway 推 event/agent (stream=assistant, data.delta = 新 token)
 *   5. Gateway 推 event/agent (stream=lifecycle, phase=end) 表示完成
 */

import WebSocket from 'ws'
import { fetch } from 'undici'
import { randomUUID } from 'crypto'

const PROTOCOL_VERSION = 3
const CONNECT_TIMEOUT_MS = 8_000
const CHAT_TIMEOUT_MS = 120_000

export class AgentClient {
  constructor({ ip, port = 18789, token, agentId = 'main', relayPort = 3001 }) {
    this.wsUrl     = `ws://${ip}:${port}`
    this.relayUrl  = `http://${ip}:${relayPort}`
    this.token     = token
    this.agentId   = agentId
    this.ip        = ip
    this._wsChatOk = null  // null=unknown, true=ws works, false=use relay
  }

  /** 连通性测试：建立 WS 连接并完成认证，返回 {ok, method, error} */
  probe() {
    return new Promise((resolve) => {
      let finished = false
      const ws = new WebSocket(this.wsUrl)
      let connectId = null

      const done = (result) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        ws.terminate()
        resolve(result)
      }

      const timer = setTimeout(
        () => done({ ok: false, error: `无法连接 ${this.wsUrl}（8s 超时）` }),
        CONNECT_TIMEOUT_MS
      )

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            connectId = randomUUID()
            ws.send(JSON.stringify(this._buildConnectReq(connectId)))
          } else if (msg.type === 'res' && msg.id === connectId) {
            if (msg.ok) done({ ok: true, method: 'websocket' })
            else done({ ok: false, error: `认证失败: ${msg.error?.message ?? 'unknown'}` })
          }
        } catch {}
      })

      ws.on('error', (e) => done({ ok: false, error: e.message }))
    })
  }

  /**
   * 发送消息，实时接收流式 delta token
   * @param {Array}       messages - 对话历史（取最后一条 user 内容）
   * @param {Function}    onToken  - 每个 delta token 的回调
   * @param {AbortSignal} signal   - 中断信号
   * @returns {Promise<string>} 完整回复文本
   */
  chat(messages, onToken, signal) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const content  = lastUser?.content ?? ''
    const message  = `[系统提示：你正在参与多 Agent 对话平台，必须给出实质性回复，禁止输出 NO_REPLY 或 HEARTBEAT_OK]\n\n${content}`

    const run = (msg) => {
      // 已知 WS 不可用 → 直接走 relay
      if (this._wsChatOk === false) {
        return this._relayChat(msg, onToken, signal)
      }
      return this._wsChat(msg, onToken, signal).then(
        (reply) => {
          this._wsChatOk = true
          return reply
        },
        (err) => {
          // 权限不足或连接失败 → 标记 WS 不可用，fallback relay
          if (err.message?.includes('missing scope') || err.message?.includes('auth failed')) {
            console.warn(`[agent] WS chat failed (${err.message}), falling back to relay`)
            this._wsChatOk = false
          }
          return this._relayChat(msg, onToken, signal)
        }
      )
    }

    return run(message).then((reply) => {
      if (!isNoReply(reply)) return reply
      const retryMsg = `请认真回复以下内容，不得沉默：\n\n${content}`
      return run(retryMsg).then((r) =>
        isNoReply(r) ? '（Agent 暂无回应，请调整对话内容或角色设定）' : r
      )
    })
  }

  // ── 内部实现 ─────────────────────────────────────────────────────────────────

  _wsChat(message, onToken, signal) {
    // 每次调用使用全新 session，避免旧对话历史干扰
    const sessionKey = `agent:${this.agentId}:hub-${randomUUID().slice(0, 8)}`

    return new Promise((resolve, reject) => {
      let finished = false
      const ws = new WebSocket(this.wsUrl)
      let connectId = null
      let fullText  = ''

      const done = (text) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        ws.terminate()
        resolve(text)
      }

      const fail = (err) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        ws.terminate()
        reject(err)
      }

      const timer = setTimeout(
        () => done(fullText || '（Agent 响应超时）'),
        CHAT_TIMEOUT_MS
      )

      if (signal) {
        signal.addEventListener('abort', () => done(fullText), { once: true })
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())

          // Step 1: 收到 challenge → 发认证请求
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            connectId = randomUUID()
            ws.send(JSON.stringify(this._buildConnectReq(connectId)))
            return
          }

          // Step 2: 认证响应
          if (msg.type === 'res' && msg.id === connectId) {
            if (!msg.ok) {
              fail(new Error(`gateway auth failed: ${msg.error?.message}`))
              return
            }
            // 认证成功 → 记录 chat req id，以便匹配响应
            const chatId = randomUUID()
            this._pendingChatId = chatId
            ws.send(JSON.stringify({
              type: 'req',
              id: chatId,
              method: 'chat.send',
              params: {
                sessionKey,
                message,
                idempotencyKey: randomUUID(),
              },
            }))
            return
          }

          // chat.send 响应（ok=false 表示权限不足等错误）
          if (msg.type === 'res' && msg.id === this._pendingChatId) {
            if (!msg.ok) {
              fail(new Error(`chat.send failed: ${msg.error?.message ?? JSON.stringify(msg.error)}`))
            }
            // ok=true → 消息已被 gateway 接受，等待 agent stream events
            return
          }

          // Step 3: 流式 agent 事件
          if (msg.type === 'event' && msg.event === 'agent') {
            const { stream, data } = msg.payload ?? {}

            if (stream === 'assistant' && data?.delta) {
              fullText = data.text ?? (fullText + data.delta)
              onToken(data.delta)
            }

            if (stream === 'lifecycle' && data?.phase === 'end') {
              done(fullText.trim())
            }
          }
        } catch {}
      })

      ws.on('error', fail)
      ws.on('close', (code) => {
        if (!finished) {
          if (fullText) done(fullText)
          else fail(new Error(`WebSocket closed (${code})`))
        }
      })
    })
  }

  _buildConnectReq(id) {
    return {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: 'gateway-client',
          version: 'dev',
          platform: process.platform,
          mode: 'backend',
        },
        caps: [],
        auth: { token: this.token },
        role: 'operator',
        scopes: ['operator.admin', 'operator.write'],
      },
    }
  }

  // ── Relay fallback (for remote agents without operator.write scope) ───────────

  async _relayChat(message, onToken, signal) {
    const url = `${this.relayUrl}/chat`
    const timeout = AbortSignal.timeout(120_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, agentId: this.agentId }),
      signal: combined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`relay ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    const text = data.text ?? data.reply ?? JSON.stringify(data)
    // Simulate streaming for relay responses (word-by-word)
    await this._simulateStream(text, onToken, signal)
    return text
  }

  async _simulateStream(text, onToken, signal) {
    const chunks = text.match(/\S+\s*/g) ?? [text]
    for (const chunk of chunks) {
      if (signal?.aborted) break
      onToken(chunk)
      await new Promise(r => setTimeout(r, 0))
    }
  }
}

// NO_REPLY / HEARTBEAT_OK 检测（大小写不敏感）
function isNoReply(text) {
  if (!text) return true
  const t = text.trim().toUpperCase()
  return t === 'NO_REPLY' || t === 'HEARTBEAT_OK' || t === 'NO_REPLY.' || t.startsWith('NO_REPLY\n')
}
