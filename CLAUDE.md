# Toss — Peer-to-peer file sharing

## What it is
Native macOS menu bar app (Swift/SwiftUI) that shares files via a link. Receivers open the link in a browser.
Transfer: HTTP direct download over LAN via embedded SwiftNIO server.

## Architecture

```
TossApp/              — Native Swift macOS sender app (menu bar + panel)
relay/                — Node.js WebSocket relay server (signaling + room management)
receiver/             — Static site (vanilla JS) opened by the person downloading
bin/dev               — Starts all three locally (relay :3001, receiver :3002, Swift app)
```

### Transfer flow
1. Sender drops file → Swift app registers shareId with relay (WebSocket)
2. Sender gets a link like `https://toss.example.com/#/<shareId>`
3. Receiver opens link → connects to relay → gets file-info + HTTP endpoints
4. Receiver downloads file via HTTP from sender's embedded SwiftNIO server
5. Password-protected files: SHA-256 token for HTTP auth (timing-safe compare)

### Key decisions
- **Native Swift.** SwiftUI + SwiftNIO, no Electron. Menu bar app with NSPanel.
- **HTTP only.** No WebRTC — simpler, LAN-focused.
- **No sandbox.** Unrestricted file access for drag-drop from Finder.
- **macOS 14+.** Enables @Observable macro.
- **No build tools for JS.** Vanilla JS in receiver — no bundler, no transpiler.
- **No TLS in containers.** Coolify's reverse proxy handles TLS termination.
- **Config via env vars.** `RELAY_URL`, `RECEIVER_URL`, `ALLOWED_ORIGIN` for the Swift app.

## File map

| File | Role |
|---|---|
| `TossApp/Package.swift` | SPM manifest: swift-nio dependency |
| `TossApp/Sources/TossApp.swift` | @main App entry point |
| `TossApp/Sources/AppDelegate.swift` | NSStatusItem + NSPanel setup |
| `TossApp/Sources/Models/SharedFile.swift` | Codable model: shareId, filePath, fileName, fileSize, passwordHash |
| `TossApp/Sources/Services/FileShareManager.swift` | Actor: CRUD shared files, JSON persistence, SHA-256 passwords |
| `TossApp/Sources/Services/HTTPFileServer.swift` | Actor: SwiftNIO HTTP server, dynamic port, file streaming, CORS, auth |
| `TossApp/Sources/Services/RelayClient.swift` | Actor: URLSessionWebSocketTask, register/unregister, reconnect |
| `TossApp/Sources/Services/NetworkInfo.swift` | getifaddrs() → local IPv4 list for HTTP endpoints |
| `TossApp/Sources/ViewModels/AppViewModel.swift` | @Observable, bridges services to SwiftUI views |
| `TossApp/Sources/Views/ContentView.swift` | Main panel: file list + drop zone + status bar |
| `TossApp/Sources/Views/FileRowView.swift` | Row: name, size, copy/lock/remove buttons |
| `TossApp/Sources/Views/DropZoneView.swift` | Empty state drop target |
| `TossApp/Sources/Utilities/MIMEType.swift` | Extension → MIME mapping |
| `TossApp/Sources/Utilities/ShareId.swift` | ShareId format validation |
| `relay/index.js` | Relay server: room management, rate limiting, signaling, ICE config |
| `receiver/receiver.js` | Receiver logic: WS → HTTP download or WebRTC fallback |
| `receiver/config.js` | Runtime config (gitignored) — sets `window.TOSS_RELAY_URL` |
| `receiver/config.example.js` | Template for config.js |

## Development

```bash
bin/dev
```

Starts relay on ws://localhost:3001, receiver on http://localhost:3002, and the Swift menu bar app.
First run: `cd relay && npm install` for relay dependencies.
Swift app builds automatically via SPM (`swift build` / `swift run`).

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

### Swift app
- Set env vars when building/distributing:
  - `RELAY_URL=wss://relay.toss.yourdomain.com`
  - `RECEIVER_URL=https://toss.yourdomain.com`
  - `ALLOWED_ORIGIN=https://toss.yourdomain.com`

## Relay internals

- **Rate limiting:** Token bucket per IP (50/sec, burst 100). Max 20 connections/IP.
- **Room TTL:** 30 min idle timeout, swept every 60s. Sender + recipients notified.
- **Memory bounds:** Max 10k rooms, 50k IP entries.
- **ShareId validation:** Must match `/^[A-Za-z0-9_-]{10,24}$/`.
- **Graceful shutdown:** SIGTERM/SIGINT close WS server, then HTTP server, 5s hard deadline.

## Conventions

- Swift app: Swift 5.10+, macOS 14+, @Observable, actors for services.
- Use `var` in receiver (browser compat). Use `const`/`let` in Node.
- IIFE wrapper in receiver.js for scope isolation.
- CORS controlled via `ALLOWED_ORIGIN` env var (defaults to `*` for dev).
- Persistence: `~/Library/Application Support/Toss/shared-files.json`

## Common tasks

**Add a new shared service:**
1. Create actor in `TossApp/Sources/Services/`
2. Wire it up in `AppViewModel.swift`
3. Expose to views via @Observable properties

**Change relay behavior:**
Edit `relay/index.js`. The switch statement in the `ws.on("message")` handler routes all message types.

**Test locally:**
`bin/dev` → drop a file in the menu bar panel → open the share URL in a browser on the same machine.
For WAN testing, use ngrok or similar to expose ports 3001 and 3002.
