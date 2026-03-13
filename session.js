/**
 * session.js — 会话和消息历史管理
 *
 * 为 Agent A / Agent B 各维护独立的 messages[] 数组。
 * 提供轮次状态机和 context 超限截断。
 */

const MAX_MESSAGES = 40  // 每个 agent 最多保留消息条数（防止 context 过长）

export class Session {
  constructor() {
    this.reset()
  }

  reset() {
    // 各自独立的对话历史
    this.historyA = []   // Agent A 的 messages[]
    this.historyB = []   // Agent B 的 messages[]

    // 完整对话记录（用于 UI 展示）
    this.transcript = []

    // 轮次状态
    this.state = 'idle'  // idle | running | stopped | done
    this.round = 0
    this.maxRounds = 10

    // 排队等候的用户插入消息
    this.pendingUserMessage = null

    // 当前流的中断控制器（用于 stop）
    this.abortController = null
  }

  setMaxRounds(n) {
    this.maxRounds = Math.max(1, Math.min(50, parseInt(n) || 10))
  }

  /** 添加用户消息，同时写入两个 agent 的历史 */
  addUserMessage(content) {
    const msg = { role: 'user', content }
    this.historyA.push(msg)
    this.historyB.push(msg)
    this.transcript.push({ from: 'user', content, ts: Date.now() })
    this._trim(this.historyA)
    this._trim(this.historyB)
  }

  /** Agent A 回复完成后记录 */
  addAgentAReply(content) {
    // A 的历史：记录为 assistant
    this.historyA.push({ role: 'assistant', content })
    // B 的历史：记录为 user（B 收到 A 的话作为输入）
    this.historyB.push({ role: 'user', content: `[Agent A]: ${content}` })
    this.transcript.push({ from: 'agentA', content, ts: Date.now() })
    this._trim(this.historyA)
    this._trim(this.historyB)
  }

  /** Agent B 回复完成后记录 */
  addAgentBReply(content) {
    // B 的历史：记录为 assistant
    this.historyB.push({ role: 'assistant', content })
    // A 的历史：记录为 user（A 收到 B 的话作为下一轮输入）
    this.historyA.push({ role: 'user', content: `[Agent B]: ${content}` })
    this.transcript.push({ from: 'agentB', content, ts: Date.now() })
    this._trim(this.historyA)
    this._trim(this.historyB)
  }

  /** 构造发给 Agent A 的 messages（含可选 system prompt） */
  buildMessagesForA(persona) {
    const messages = []
    if (persona) messages.push({ role: 'system', content: persona })
    return messages.concat(this.historyA)
  }

  /** 构造发给 Agent B 的 messages（含可选 system prompt） */
  buildMessagesForB(persona) {
    const messages = []
    if (persona) messages.push({ role: 'system', content: persona })
    return messages.concat(this.historyB)
  }

  /** 滑动窗口截断：保留最新 MAX_MESSAGES 条 */
  _trim(arr) {
    if (arr.length > MAX_MESSAGES) {
      arr.splice(0, arr.length - MAX_MESSAGES)
    }
  }

  isRunning() { return this.state === 'running' }
  isDone()    { return this.state === 'done' || this.state === 'stopped' }

  start() {
    this.state = 'running'
    this.round = 0
    this.abortController = new AbortController()
  }

  stop() {
    this.state = 'stopped'
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  nextRound() {
    this.round++
    if (this.round >= this.maxRounds) {
      this.state = 'done'
      return false
    }
    return true
  }

  /** 插入用户消息（当前轮次结束后生效） */
  injectMessage(content) {
    this.pendingUserMessage = content
  }

  consumePending() {
    const msg = this.pendingUserMessage
    this.pendingUserMessage = null
    return msg
  }
}
