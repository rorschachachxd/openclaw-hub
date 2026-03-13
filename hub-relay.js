/**
 * hub-relay.js — 远端 OpenClaw 机器上运行的 HTTP relay
 *
 * 用法（在远端机器上执行）：
 *   node hub-relay.js
 *   # 或指定端口：PORT=3001 node hub-relay.js
 *
 * 依赖：仅需 Node.js（无需 npm install）
 */

import http from 'http'
import { spawn } from 'child_process'

const PORT     = parseInt(process.env.PORT) || 3001
const AGENT_ID = process.env.AGENT_ID || 'main'

const server = http.createServer((req, res) => {
  const setCORS = () => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  if (req.method === 'OPTIONS') {
    setCORS(); res.writeHead(204); res.end(); return
  }

  if (req.method === 'GET' && req.url === '/health') {
    setCORS()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, agent: AGENT_ID }))
    return
  }

  if (req.method === 'POST' && req.url === '/chat') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      let message, agentId
      try {
        const parsed = JSON.parse(body)
        message = parsed.message
        agentId = parsed.agentId || AGENT_ID
      } catch {
        setCORS()
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON' }))
        return
      }

      if (!message) {
        setCORS()
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'message required' }))
        return
      }

      console.log(`[relay] → agent:${agentId}  "${message.slice(0, 60)}..."`)

      const proc = spawn('openclaw', ['agent', '--agent', agentId, '-m', message, '--json'])
      let out = ''
      proc.stdout.on('data', d => out += d)
      proc.stderr.on('data', () => {})

      proc.on('close', (code) => {
        setCORS()
        if (code === 0 || out.includes('"status"')) {
          try {
            const json  = JSON.parse(out)
            const text  = json?.result?.payloads?.[0]?.text
                       ?? json?.payloads?.[0]?.text
                       ?? json?.text
                       ?? out.trim()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, text }))
            console.log(`[relay] ← ${text.slice(0, 60)}...`)
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, text: out.trim() }))
          }
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `agent exit ${code}`, detail: out.slice(0, 500) }))
        }
      })

      proc.on('error', (e) => {
        setCORS()
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      })
    })
    return
  }

  res.writeHead(404); res.end('Not Found')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦞 OpenClaw Hub Relay`)
  console.log(`   Port  : ${PORT}`)
  console.log(`   Agent : ${AGENT_ID}`)
  console.log(`   Ready : http://0.0.0.0:${PORT}/health\n`)
})
