# Toss — Peer-to-peer file sharing

## What it is
Electron desktop app that shares files via a link. Receivers open the link in a browser.
Primary transfer: HTTP direct download over LAN. Fallback: WebRTC via relay for WAN/NAT.

## Architecture

```
app/          — Electron sender app (main + renderer + preload)
relay/        — Node.js WebSocket relay server (signaling + room management)
receiver/     — Static site (vanilla JS) opened by the person downloading
bin/dev       — Starts all three locally (relay :3001, receiver :3002, Electron)
```

### Transfer flow
1. Sender drops file → Electron registers shareId with relay (WebSocket)
2. Sender gets a link like `https://toss.example.com/#/<shareId>`
3. Receiver opens link → connects to relay → gets file-info + HTTP endpoints
4. Receiver tries HTTP direct download (LAN fast path) from sender's embedded HTTP server
5. If HTTP fails (WAN/NAT), WebRTC data channel kicks in via relay signaling
6. Password-protected files: SHA-256 token for HTTP, timing-safe IPC check for WebRTC

### Key decisions
- **No build tools.** Vanilla JS everywhere — no bundler, no transpiler, no framework.
- **No TLS in containers.** Coolify's reverse proxy (Traefik/Caddy) handles TLS termination.
- **Password never leaves main process.** Renderer calls `verifyPassword` IPC, which uses `crypto.timingSafeEqual`.
- **Config via env vars.** `RELAY_URL`, `RECEIVER_URL`, `ALLOWED_ORIGIN` for the Electron app. `PORT`, `ALLOWED_ORIGIN`, `TURN_SERVER`, `TURN_SECRET` for the relay.

## File map

| File | Role |
|---|---|
| `app/main.js` | Electron main process: HTTP file server, relay WS client, IPC handlers |
| `app/preload.js` | Context bridge exposing IPC to renderer |
| `app/renderer/app.js` | Sender UI: drag-drop, WebRTC peer connections, file streaming |
| `app/renderer/index.html` | Sender HTML |
| `relay/index.js` | Relay server: room management, rate limiting, signaling, ICE config |
| `receiver/receiver.js` | Receiver logic: WS → HTTP download or WebRTC fallback |
| `receiver/config.js` | Runtime config (gitignored) — sets `window.TOSS_RELAY_URL` |
| `receiver/config.example.js` | Template for config.js |

## Development

```bash
bin/dev
```

Starts relay on ws://localhost:3001, receiver on http://localhost:3002, and the Electron app.
No `npm install` needed for relay beyond the initial setup (`cd relay && npm install`).
Electron app: `cd app && npm install`.

## Deployment (Coolify on Hetzner)

Two services from the same repo:

### toss-relay
- Docker context: `relay/`
- Port: 3001
- Env: `PORT=3001`, `ALLOWED_ORIGIN=https://toss.yourdomain.com`
- Optional: `TURN_SERVER`, `TURN_SECRET`, `TURN_TTL`
- Health check: `GET /health`

### toss-receiver
- Docker context: `receiver/`
- Port: 80 (nginx)
- Set `window.TOSS_RELAY_URL` in `config.js` to `wss://relay.toss.yourdomain.com`

### Electron app
- Set env vars when building/distributing:
  - `RELAY_URL=wss://relay.toss.yourdomain.com`
  - `RECEIVER_URL=https://toss.yourdomain.com`

## Relay internals

- **Rate limiting:** Token bucket per IP (50/sec, burst 100). Max 20 connections/IP.
- **Room TTL:** 30 min idle timeout, swept every 60s. Sender + recipients notified.
- **Memory bounds:** Max 10k rooms, 50k IP entries.
- **ShareId validation:** Must match `/^[A-Za-z0-9_-]{10,24}$/`.
- **Graceful shutdown:** SIGTERM/SIGINT close WS server, then HTTP server, 5s hard deadline.

## Conventions

- No TypeScript, no JSX, no build step.
- Use `var` in receiver (browser compat). Use `const`/`let` in Node and Electron renderer.
- IIFE wrapper in receiver.js for scope isolation.
- IPC channel names are kebab-case: `read-file-chunk`, `verify-password`, etc.
- CORS controlled via `ALLOWED_ORIGIN` env var (defaults to `*` for dev).

## Common tasks

**Add a new IPC handler:**
1. Add handler in `app/main.js` with `ipcMain.handle("name", ...)`
2. Expose in `app/preload.js` via `contextBridge`
3. Call from renderer as `window.toss.name(...)`

**Change relay behavior:**
Edit `relay/index.js`. The switch statement in the `ws.on("message")` handler routes all message types.

**Test locally:**
`bin/dev` → drop a file in the Electron app → open the share URL in a browser on the same machine.
For WAN testing, use ngrok or similar to expose ports 3001 and 3002.
