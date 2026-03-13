# OpenClaw Hub

**OpenClaw Hub** 是一个本地部署的双 Agent 对话平台，让两台机器上的 [OpenClaw](https://openclaw.ai) Agent 自动互相讨论，用户可随时插入指令干预对话。

![界面预览](https://img.shields.io/badge/UI-三栏对话-4f9cf9?style=flat-square) ![Node.js](https://img.shields.io/badge/Node.js-v18+-green?style=flat-square) ![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

---

## 功能特性

- **双 Agent 自动对话** — Agent A 与 Agent B 轮流发言，自动推进讨论
- **实时流式显示** — 基于 SSE（Server-Sent Events），token 逐字出现，打字机效果
- **用户随时插入** — 对话进行中可发送消息中断并引导讨论方向
- **三栏式 UI** — User / Agent A / Agent B 独立展示，一目了然
- **可配置角色设定** — 为每个 Agent 设置 System Prompt，赋予不同专业背景
- **最大轮数控制** — 防止无限循环，可配置 1–50 轮
- **NO\_REPLY 自动防护** — 自动检测并重试，避免 Agent 沉默无响应
- **零云端依赖** — 完全本地运行，数据不出局域网

---

## 系统架构

```
┌──────────────────────────────────────┐
│            Web UI (浏览器)            │
│   [配置面板]          [三栏对话]      │
└──────────────┬───────────────────────┘
               │ SSE token 流 + HTTP
               ▼
┌──────────────────────────────────────┐
│          Dialogue Server             │
│          Node.js + Express           │
│   ┌──────────┐   ┌────────────────┐  │
│   │ 会话管理  │   │  SSE 实时广播  │  │
│   │ 轮次调度  │   │  (零缓冲推送)  │  │
│   └──────────┘   └────────────────┘  │
└───────┬──────────────────┬───────────┘
        │ HTTP / CLI       │ HTTP Relay
        ▼                  ▼
┌──────────────┐   ┌──────────────────┐
│  OpenClaw A  │   │   OpenClaw B     │
│  (本机)      │   │  (远端机器)      │
│  127.0.0.1   │   │  192.168.x.x     │
│  :18789      │   │  hub-relay.js    │
└──────────────┘   └──────────────────┘
```

**Dialogue Server** 是核心调度器，负责：
1. 接收用户消息，写入双方对话历史
2. 顺序调用 Agent A → Agent B，收集回复
3. 通过 SSE 将 token 实时推送到浏览器
4. 控制轮次、处理中断、检测 NO\_REPLY

---

## 目录结构

```
openclaw-hub/
├── server.js           # Dialogue Server 主入口（Express + SSE + 轮次调度）
├── agent-client.js     # OpenClaw 调用客户端（本机 CLI / 远端 Relay）
├── session.js          # 会话历史管理（滑动窗口截断）
├── hub-relay.js        # 远端机器上运行的 HTTP Relay（无需额外依赖）
├── package.json
└── public/
    ├── index.html      # 单页 Web UI（配置面板 + 三栏对话）
    ├── chat.js         # SSE 客户端 + 对话控制逻辑
    └── style.css       # 深色主题样式
```

---

## 环境要求

- **Node.js** v18 或以上
- **OpenClaw** 已安装并运行（至少一台机器）
- 两台机器在同一局域网（或可互相访问）

---

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/rorschachachxd/openclaw-hub.git
cd openclaw-hub
npm install
```

### 2. 启动 Dialogue Server

```bash
node server.js
```

默认监听 `http://localhost:3000`，可通过环境变量修改端口：

```bash
PORT=8080 node server.js
```

### 3. 开放远端机器的 Gateway（每台远端机器执行一次）

OpenClaw Gateway 默认只监听本机，需要开放局域网访问：

```bash
# 在远端机器上执行
openclaw config set gateway.bind lan
openclaw gateway restart
```

### 4. 在远端机器上启动 Relay

`hub-relay.js` 是一个轻量 HTTP 中继，无需 `npm install`，直接用 Node.js 运行：

```bash
# 将 hub-relay.js 复制到远端机器
scp hub-relay.js user@192.168.1.x:~/

# 在远端机器上启动
node ~/hub-relay.js
# 或指定端口和 Agent ID
PORT=3001 AGENT_ID=main node ~/hub-relay.js
```

### 5. 打开配置面板

访问 `http://localhost:3000`，点击右上角「⚙ 配置」，填写：

| 字段 | 说明 |
|------|------|
| IP 地址 | Agent 所在机器的 IP（本机填 `127.0.0.1`） |
| 端口 | OpenClaw Gateway 端口，默认 `18789` |
| Auth Token | 该机器 `~/.openclaw/openclaw.json` 里的 `gateway.auth.token` |
| 角色设定 | 可选，给 Agent 设置专属 System Prompt |
| Relay 端口 | 远端机器上 `hub-relay.js` 监听的端口，默认 `3001` |
| Agent ID | OpenClaw Agent 名称，默认 `main` |
| 最大轮数 | 单次对话最多几轮，默认 `10` |

填完后点「**保存配置**」→「**连通性测试**」，两个 Agent 都显示 ✓ 即可开始对话。

---

## 使用方式

### 启动对话

在底部输入框输入问题，按 **Enter** 或点「发送」。

对话流程：
```
你的消息
  → Agent A 思考并回复（实时流式显示）
    → Agent B 收到 A 的回复，继续讨论（实时流式显示）
      → Agent A 收到 B 的回复，继续...
        → 达到最大轮数，对话结束
```

### 插入消息

对话进行中可随时发送新消息，当前轮次完成后自动插入，引导讨论方向。

### 停止对话

点「**停止**」按钮立即终止当前轮次。

### 查找 Auth Token

```bash
cat ~/.openclaw/openclaw.json | grep -A5 '"auth"'
```

找到如下内容中的 `token` 值：
```json
"auth": {
  "mode": "token",
  "token": "your-token-here"
}
```

---

## Agent 调用机制

### 本机 Agent（127.0.0.1）

直接调用本机 OpenClaw CLI：

```bash
openclaw agent --agent main -m "消息内容" --json
```

### 远端 Agent（其他 IP）

通过 `hub-relay.js` 中转：

```
Dialogue Server → HTTP POST http://192.168.x.x:3001/chat → hub-relay.js → openclaw agent CLI
```

Relay 暴露两个接口：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查，返回 `{"ok":true}` |
| `/chat` | POST | 发送消息，返回 Agent 回复 |

请求格式：
```json
{
  "message": "你的消息",
  "agentId": "main"
}
```

---

## 对话流程详解

```
用户发送消息
    │
    ▼
Dialogue Server 写入双方历史
    │
    ├─► 调用 Agent A（with 完整历史 + Persona）
    │       每个 token → SSE 推送 {agent:"A", token:"..."}
    │       A 完成 → 回复写入历史
    │
    ▼
A 的回复作为 B 的新输入
    │
    ├─► 调用 Agent B（with 完整历史 + Persona）
    │       每个 token → SSE 推送 {agent:"B", token:"..."}
    │       B 完成 → 回复写入历史
    │
    ▼
轮次 +1
    ├─ 未达上限 → 将 B 的回复发给 A，继续下一轮
    └─ 已达上限 → 推送 {type:"done"}，对话结束
```

---

## 配置说明

配置保存在 `config.json`（已加入 `.gitignore`，不会上传到 GitHub）：

```json
{
  "agentA": {
    "ip": "127.0.0.1",
    "port": 18789,
    "token": "your-token-a",
    "persona": "你是一个后端架构师，偏向微服务设计",
    "relayPort": 3001,
    "agentId": "main"
  },
  "agentB": {
    "ip": "192.168.1.11",
    "port": 18789,
    "token": "your-token-b",
    "persona": "你是一个 DevOps 专家，倾向简单高效的部署方案",
    "relayPort": 3001,
    "agentId": "main"
  },
  "maxRounds": 10
}
```

---

## 常见问题

**Q: Agent 返回 NO\_REPLY 或没有回应？**

已内置自动防护：收到 `NO_REPLY` 或 `HEARTBEAT_OK` 时自动重试一次。如果仍然无响应，尝试在「角色设定」中加入"请始终给出实质性回复"。

**Q: 连通性测试失败，远端机器无法连接？**

1. 确认远端机器已执行 `openclaw config set gateway.bind lan && openclaw gateway restart`
2. 确认 `hub-relay.js` 正在运行且端口未被防火墙拦截
3. 用 `nc -zv <IP> <port>` 检查端口连通性

**Q: 如何修改 Dialogue Server 端口？**

```bash
PORT=8080 node server.js
```

**Q: 支持超过两个 Agent 吗？**

当前版本固定为 A/B 双 Agent 轮流对话，多 Agent 支持在计划中。

---
