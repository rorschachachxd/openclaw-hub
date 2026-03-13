/**
 * agent-client.js — OpenClaw Agent 调用客户端
 *
 * 两种模式：
 *   local  — 直接调用本机 CLI: openclaw agent --agent main -m "msg" --json
 *   relay  — 调用远端机器上运行的 hub-relay.js HTTP 接口
 *
 * 自动选择：ip 是 127.0.0.1 / localhost → local，否则 → relay
 */

import { fetch } from 'undici'
import { spawn } from 'child_process'

export class AgentClient {
  constructor({ ip, port = 18789, token, relayPort = 3001, agentId = 'main' }) {
    this.ip        = ip
    this.port      = port
    this.token     = token
    this.relayPort = relayPort
    this.agentId   = agentId
    this.isLocal   = (ip === '127.0.0.1' || ip === 'localhost')
  }

  /** 连通性测试，返回 {ok, method, error} */
  async probe() {
    if (this.isLocal) {
      return this._probeLocal()
    } else {
      return this._probeRelay()
    }
  }

  /**
   * 发送消息，收到完整回复后调用 onToken 逐字播放（模拟流式）
   * @param {Array}    messages  - 对话历史（取最后一条 user 内容发送）
   * @param {Function} onToken   - 每个字符回调
   * @param {AbortSignal} signal - 中断信号
   * @returns {Promise<string>}
   */
  async chat(messages, onToken, signal) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    // 在消息前加强制回复指令，防止 agent 输出 NO_REPLY / HEARTBEAT_OK
    const message  = `[系统提示：你正在参与一个多 Agent 对话平台，必须给出实质性回复，禁止输出 NO_REPLY 或 HEARTBEAT_OK]\n\n${lastUser?.content ?? ''}`

    let reply
    if (this.isLocal) {
      reply = await this._localChat(message, signal)
    } else {
      reply = await this._relayChat(message, signal)
    }

    // 如果 agent 仍然输出了 NO_REPLY，重试一次并明确要求回复
    if (isNoReply(reply)) {
      const retryMsg = `请你认真回复以下内容，不得沉默：\n\n${lastUser?.content ?? ''}`
      reply = this.isLocal
        ? await this._localChat(retryMsg, signal)
        : await this._relayChat(retryMsg, signal)
    }

    // 最终兜底：仍然是 NO_REPLY 则替换为提示
    if (isNoReply(reply)) {
      reply = '（Agent 暂无回应，请调整对话内容或角色设定）'
    }

    // 模拟流式：逐字播出（让 UI 有打字机效果）
    await this._simulateStream(reply, onToken, signal)
    return reply
  }

  // ── 本机 CLI ────────────────────────────────────────────────────────────────

  _probeLocal() {
    return new Promise((resolve) => {
      // 用 health check 替代 agent call，避免触发真实推理导致超时
      const proc = spawn('openclaw', ['health'])
      let out = ''
      proc.stdout.on('data', d => out += d)
      proc.on('close', code => {
        if (code === 0) resolve({ ok: true, method: 'local-cli' })
        else resolve({ ok: false, error: `openclaw health failed (${code}): ${out.slice(0, 200)}` })
      })
      proc.on('error', e => resolve({ ok: false, error: e.message }))
      setTimeout(() => { proc.kill(); resolve({ ok: false, error: 'timeout' }) }, 8000)
    })
  }

  _localChat(message, signal) {
    return new Promise((resolve, reject) => {
      const args = ['agent', '--agent', this.agentId, '-m', message, '--json']
      const proc = spawn('openclaw', args)
      let out = ''

      proc.stdout.on('data', d => out += d)
      proc.stderr.on('data', () => {})  // 忽略装饰性输出

      proc.on('close', (code) => {
        if (code === 0 || out.includes('"status"')) {
          try {
            const json = JSON.parse(out)
            const text = json?.result?.payloads?.[0]?.text
                      ?? json?.payloads?.[0]?.text
                      ?? json?.text
                      ?? out.trim()
            resolve(text)
          } catch {
            resolve(out.trim())
          }
        } else {
          reject(new Error(`openclaw agent exited with code ${code}: ${out.slice(0, 200)}`))
        }
      })

      proc.on('error', reject)

      if (signal) {
        signal.addEventListener('abort', () => { proc.kill(); resolve('') }, { once: true })
      }
    })
  }

  // ── 远端 relay ──────────────────────────────────────────────────────────────

  async _probeRelay() {
    const url = `http://${this.ip}:${this.relayPort}/health`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (res.ok) return { ok: true, method: 'relay' }
      return { ok: false, error: `relay HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, error: `无法连接 relay ${this.ip}:${this.relayPort} — ${e.message}\n请先在该机器上运行 hub-relay.js` }
    }
  }

  async _relayChat(message, signal) {
    const url = `http://${this.ip}:${this.relayPort}/chat`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, agentId: this.agentId }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`relay ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json()
    return data.text ?? data.reply ?? JSON.stringify(data)
  }

  // ── 模拟流式输出 ────────────────────────────────────────────────────────────

  async _simulateStream(text, onToken, signal) {
    // 按词组（非空格分组 + 空格）分批推送，比逐字更自然
    const chunks = text.match(/\S+\s*/g) ?? [text]
    for (const chunk of chunks) {
      if (signal?.aborted) break
      onToken(chunk)
      // 极短延迟让浏览器有机会渲染
      await new Promise(r => setTimeout(r, 0))
    }
  }
}

// NO_REPLY / HEARTBEAT_OK 检测（大小写不敏感，允许前后有空白）
function isNoReply(text) {
  if (!text) return true
  const t = text.trim().toUpperCase()
  return t === 'NO_REPLY' || t === 'HEARTBEAT_OK' || t === 'NO_REPLY.' || t.startsWith('NO_REPLY\n')
}
