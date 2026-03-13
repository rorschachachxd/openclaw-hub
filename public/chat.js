// chat.js — SSE 客户端 + 对话控制逻辑

let cfg = {}
let isRunning = false

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const configPanel  = $('config-panel')
const toggleCfgBtn = $('toggle-config')
const saveBtn      = $('save-config')
const testBtn      = $('test-conn')
const testResult   = $('test-result')

const msgUser  = $('msgs-user')
const msgA     = $('msgs-a')
const msgB     = $('msgs-b')

const statusA  = $('status-a')
const statusB  = $('status-b')

const inputBox = $('input-box')
const sendBtn  = $('send-btn')
const stopBtn  = $('stop-btn')
const resetBtn = $('reset-btn')
const statusBar= $('statusbar')

// ── Load config ───────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch('/config')
    cfg = await res.json()
    applyConfigToForm(cfg)
  } catch (e) {
    log('配置加载失败: ' + e.message)
  }
}

function applyConfigToForm(c) {
  const a = c.agentA || {}
  const b = c.agentB || {}
  $('a-ip').value         = a.ip        || ''
  $('a-port').value       = a.port      || 18789
  $('a-token').value      = a.token     || ''
  $('a-persona').value    = a.persona   || ''
  $('a-agent-id').value   = a.agentId   || 'main'
  $('b-ip').value         = b.ip        || ''
  $('b-port').value       = b.port      || 18789
  $('b-token').value      = b.token     || ''
  $('b-persona').value    = b.persona   || ''
  $('b-agent-id').value   = b.agentId   || 'main'
  $('max-rounds').value   = c.maxRounds || 10
}

function collectConfig() {
  return {
    agentA: {
      ip:        $('a-ip').value.trim(),
      port:      parseInt($('a-port').value) || 18789,
      token:     $('a-token').value.trim(),
      persona:   $('a-persona').value.trim(),
      agentId:   $('a-agent-id').value.trim() || 'main',
    },
    agentB: {
      ip:        $('b-ip').value.trim(),
      port:      parseInt($('b-port').value) || 18789,
      token:     $('b-token').value.trim(),
      persona:   $('b-persona').value.trim(),
      agentId:   $('b-agent-id').value.trim() || 'main',
    },
    maxRounds: parseInt($('max-rounds').value) || 10,
  }
}

// ── Config actions ────────────────────────────────────────────────────────────
toggleCfgBtn.addEventListener('click', () => {
  configPanel.classList.toggle('hidden')
  toggleCfgBtn.textContent = configPanel.classList.contains('hidden') ? '⚙ 配置' : '✕ 关闭'
})

saveBtn.addEventListener('click', async () => {
  cfg = collectConfig()
  await fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  showTestResult('已保存', 'ok')
})

testBtn.addEventListener('click', async () => {
  showTestResult('测试中…', '')
  const res = await fetch('/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ which: 'all' }),
  })
  const data = await res.json()
  const lines = Object.entries(data).map(([k, v]) =>
    `Agent ${k}: ${v.ok ? `✓ ${v.method || 'ok'}` : `✗ ${v.error}`}`
  )
  showTestResult(lines.join('\n'), Object.values(data).every(v => v.ok) ? 'ok' : 'fail')
})

function showTestResult(text, cls) {
  testResult.textContent = text
  testResult.className = 'test-result' + (cls ? ` ${cls}` : '')
  testResult.style.display = 'block'
}

// ── SSE ───────────────────────────────────────────────────────────────────────
let evtSource = null
let currentBubbleA = null
let currentBubbleB = null

function connectSSE() {
  if (evtSource) evtSource.close()
  evtSource = new EventSource('/events')

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data)
    handleEvent(data)
  }

  evtSource.onerror = () => {
    log('SSE 断开，3s 后重连…')
    setTimeout(connectSSE, 3000)
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'connected':
      log('已连接')
      break

    case 'user':
      addBubble(msgUser, ev.content, 'user')
      break

    case 'user-injected':
      addBubble(msgUser, `[插入] ${ev.content}`, 'user')
      addBubble(msgA, `[用户插入了新消息]`, 'sys')
      addBubble(msgB, `[用户插入了新消息]`, 'sys')
      break

    case 'agent-start':
      if (ev.agent === 'A') {
        currentBubbleA = addBubble(msgA, '', 'agent-a streaming')
        setStatus(statusA, '思考中…', true)
        isRunning = true
        updateBtns()
      } else {
        currentBubbleB = addBubble(msgB, '', 'agent-b streaming')
        setStatus(statusB, '思考中…', true)
      }
      break

    case 'token':
      if (ev.agent === 'A' && currentBubbleA) {
        currentBubbleA._rawText = (currentBubbleA._rawText || '') + ev.token
        currentBubbleA.textContent = currentBubbleA._rawText
        scrollTo(msgA)
      } else if (ev.agent === 'B' && currentBubbleB) {
        currentBubbleB._rawText = (currentBubbleB._rawText || '') + ev.token
        currentBubbleB.textContent = currentBubbleB._rawText
        scrollTo(msgB)
      }
      break

    case 'agent-done':
      if (ev.agent === 'A') {
        if (currentBubbleA) {
          currentBubbleA.classList.remove('streaming')
          renderMarkdown(currentBubbleA, currentBubbleA._rawText || ev.content)
        }
        setStatus(statusA, '完成', false)
        currentBubbleA = null
      } else {
        if (currentBubbleB) {
          currentBubbleB.classList.remove('streaming')
          renderMarkdown(currentBubbleB, currentBubbleB._rawText || ev.content)
        }
        setStatus(statusB, '完成', false)
        currentBubbleB = null
      }
      break

    case 'agent-error':
      addBubble(ev.agent === 'A' ? msgA : msgB, `[错误] ${ev.content}`, 'sys')
      break

    case 'done':
      isRunning = false
      setStatus(statusA, '待机', false)
      setStatus(statusB, '待机', false)
      addBubble(msgUser, `对话结束（共 ${ev.rounds} 轮）`, 'sys')
      updateBtns()
      log(`对话完成，共 ${ev.rounds} 轮`)
      break

    case 'stopped':
      isRunning = false
      setStatus(statusA, '已停止', false)
      setStatus(statusB, '已停止', false)
      updateBtns()
      log('对话已停止')
      break

    case 'error':
      addBubble(msgUser, `[系统错误] ${ev.content}`, 'sys')
      isRunning = false
      updateBtns()
      break
  }
}

// ── Chat input ────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage)
inputBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})
// 自动高度
inputBox.addEventListener('input', () => {
  inputBox.style.height = '40px'
  inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + 'px'
})

async function sendMessage() {
  const msg = inputBox.value.trim()
  if (!msg) return
  inputBox.value = ''
  inputBox.style.height = '40px'

  await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg }),
  })
}

stopBtn.addEventListener('click', async () => {
  await fetch('/stop', { method: 'POST' })
})

resetBtn.addEventListener('click', () => {
  if (isRunning) return
  clearMessages()
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function addBubble(container, text, classes = '') {
  const div = document.createElement('div')
  div.className = `bubble ${classes}`
  div.textContent = text
  container.appendChild(div)
  scrollTo(container)
  return div
}

function renderMarkdown(el, text) {
  if (!text) return
  try {
    const html = DOMPurify.sanitize(marked.parse(text))
    el.innerHTML = html
    el.classList.add('markdown')
    scrollTo(el.parentElement)
  } catch {
    el.textContent = text
  }
}

function scrollTo(el) {
  el.scrollTop = el.scrollHeight
}

function clearMessages() {
  msgUser.innerHTML = ''
  msgA.innerHTML    = ''
  msgB.innerHTML    = ''
}

function setStatus(el, text, active) {
  el.textContent = text
  el.className = 'col-status' + (active ? ' active' : '')
}

function updateBtns() {
  sendBtn.disabled = isRunning
  stopBtn.style.display = isRunning ? '' : 'none'
}

function log(text) {
  statusBar.textContent = text
}

// ── Init ──────────────────────────────────────────────────────────────────────
updateBtns()
stopBtn.style.display = 'none'
loadConfig()
connectSSE()
