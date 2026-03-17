# Toss M1 — Proof of Life

## What we're building

A desktop app (Mac only, Electron) that lets you drag a file onto a window, generates a unique shareable URL, and allows anyone with that URL to download the file directly from your machine via a peer-to-peer WebRTC connection. No cloud storage, no file upload — the file never leaves the sender's computer.

## Architecture overview

Three components:

1. **Relay Server** — Node.js + WebSocket. Handles signaling only (helps sender and recipient find each other). Never touches file data.
2. **Electron App** — The sender's app. Manages files, runs a WebRTC peer, connects to the relay.
3. **Web Receiver** — A static HTML page the recipient opens in their browser. Connects to relay, establishes WebRTC with sender, downloads file directly.

```
Sender (Electron)          Relay Server          Recipient (Browser)
      |                         |                         |
      |── register: id=abc ──►  |                         |
      |                         |  ◄── "I want abc" ──    |
      |  ◄── "someone wants" ── |                         |
      |                         |                         |
      |══════════ WebRTC direct (relay steps out) ════════|
      |                         |                         |
      |── file bytes ──────────────────────────────────►  |
```

---

## Task 0 — Project scaffolding ✅

Create the project root structure:

```
toss/
├── bin/
│   └── dev          # Starts all 3 services (relay, receiver, electron)
├── relay/           # Node.js relay server
│   ├── package.json
│   └── index.js
├── app/             # Electron app (sender)
│   ├── package.json
│   ├── main.js      # Electron main process + relay WS + file I/O
│   ├── preload.js   # Preload script for IPC
│   └── renderer/    # Frontend UI + WebRTC sender logic
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── receiver/        # Static web receiver page
│   ├── index.html
│   ├── styles.css
│   └── receiver.js
└── plan.md
```

> **Deviation from plan:** WebRTC + signaling logic lives directly in `app/main.js` and `app/renderer/app.js` instead of separate `lib/` files. Simpler for M1. `bin/dev` added to run all services with one command.

Use the following versions/dependencies:

- **Electron**: latest stable
- **relay**: `ws` package for WebSocket server
- **WebRTC in Electron**: `wrtc` npm package (provides WebRTC APIs in Node.js context) — OR use the built-in Chromium WebRTC from the renderer process
- **No bundler needed for M1** — keep it simple, no webpack/vite yet

---

## Task 1 — Relay Server ✅

File: `relay/index.js`

A minimal WebSocket signaling server. It does NOT touch files — only passes signaling messages between sender and recipient.

### Behavior:

- Listen on port `3001` (configurable via `PORT` env var)
- Accept WebSocket connections
- Two types of clients connect:
  - **Senders** — register with a `shareId` (the unique ID for each shared file)
  - **Recipients** — request connection to a specific `shareId`

### Protocol (JSON messages over WebSocket):

**Sender → Relay:**

```json
{ "type": "register", "shareId": "abc123" }
```

Registers this sender's WebSocket as the owner of `shareId`. Store in a Map: `shareId → senderSocket`.

**Sender → Relay (unregister):**

```json
{ "type": "unregister", "shareId": "abc123" }
```

Removes the shareId from the map.

**Recipient → Relay:**

```json
{ "type": "request", "shareId": "abc123" }
```

Relay looks up `shareId`. If found, relay creates a pairing and begins forwarding signaling messages between sender and recipient.

**Signaling forwarding (both directions):**

```json
{
  "type": "signal",
  "shareId": "abc123",
  "data": {
    /* WebRTC offer/answer/ICE candidate */
  }
}
```

Relay forwards `data` to the other party. That's it.

**Error:**

```json
{ "type": "error", "message": "Share not found" }
```

### Important:

- One sender can register MULTIPLE shareIds (one per file)
- Multiple recipients can request the same shareId (one at a time for M1 — no parallel downloads needed yet)
- When a sender disconnects, clean up ALL its shareIds
- Log connections/disconnections to stdout for debugging
- CORS is irrelevant here (WebSocket), but add basic health check on HTTP GET `/` returning `{ "status": "ok" }`

---

## Task 2 — Electron App: Main Process ✅

File: `app/main.js`

### Window setup:

- Single window, 480×600px, resizable
- Frameless: NO (use standard macOS title bar for M1)
- `nodeIntegration: false`, `contextIsolation: true` — use preload script
- Load `renderer/index.html`

### Preload (`app/preload.js`):

Expose these APIs to the renderer via `contextBridge.exposeInMainWorld('toss', { ... })`:

- `addFile(filePath)` → returns `{ shareId, fileName, fileSize }`
- `removeFile(shareId)` → void
- `getFiles()` → returns array of shared files
- `onTransferProgress(callback)` → listen for transfer progress events
- `onConnectionStatus(callback)` → listen for relay connection status
- `getShareUrl(shareId)` → returns the full URL for the recipient

### Main process responsibilities:

- Generate a unique `shareId` per file (use `crypto.randomUUID()`, take first 8 chars)
- Maintain a Map of `shareId → { filePath, fileName, fileSize }`
- Connect to relay server via WebSocket (keep connection alive, reconnect on drop)
- Register each shareId with the relay
- When relay forwards a signaling message from a recipient:
  - Create a new WebRTC peer connection (RTCPeerConnection)
  - Handle offer/answer/ICE exchange via relay
  - Once data channel opens, read the file from disk and stream it through the data channel
- Unregister shareId when file is removed

### File streaming over WebRTC Data Channel:

- Data channels have a message size limit (~16KB-64KB depending on implementation)
- Read file in chunks of 16KB
- Send a metadata message first: `{ type: "metadata", fileName, fileSize, mimeType }`
- Then send binary chunks sequentially
- Send a final message: `{ type: "done" }`
- Report progress back to renderer via IPC

### Relay URL:

- Default to `ws://localhost:3001` for development
- Make configurable (env var or hardcoded constant for M1)

---

## Task 3 — Electron App: Renderer (UI) ✅

Files: `app/renderer/index.html`, `app/renderer/styles.css`, `app/renderer/app.js`

### Layout:

Minimal, clean UI. Think of it as a single-purpose tool.

1. **Drop zone** — Large area at the top. Text: "Drop a file to toss". Supports drag & drop.
2. **File list** — Below the drop zone. Each item shows:
   - File name (truncated if long)
   - File size (human-readable: KB, MB, GB)
   - Copy link button → copies share URL to clipboard
   - Remove button (×) → stops sharing, kills the link
   - Status indicator: "Ready" / "Transferring..." / "Idle"
3. **Connection indicator** — Small dot at bottom: green = connected to relay, red = disconnected

### Drag & drop:

- Listen for `dragover` and `drop` events on the drop zone
- On drop, get the file path from the event (`event.dataTransfer.files[0].path`)
- Call `window.toss.addFile(filePath)`
- Add the file to the list

### Share URL format:

```
https://usetoss.app/s/{shareId}
```

For development, use `http://localhost:3002/#/{shareId}` (the receiver dev server).

### Styling:

- Dark background (#1a1a1a), light text (#e0e0e0)
- Monospace font for shareIds/URLs
- Rounded corners, subtle borders
- Minimal — no gradients, no shadows, no animations for M1
- macOS-native feel: system font for UI text (-apple-system, BlinkMacSystemFont)

---

## Task 4 — Web Receiver ✅

Files: `receiver/index.html`, `receiver/styles.css`, `receiver/receiver.js`

This is what the recipient opens in their browser. A single static page.

### URL routing:

- The page reads the `shareId` from the URL path: `/s/{shareId}`
- For M1, you can use a hash route instead: `index.html#shareId` (avoids needing a server with URL rewriting)

### Flow:

1. Page loads, extracts `shareId` from URL
2. Connects to relay via WebSocket
3. Sends `{ "type": "request", "shareId": "..." }`
4. Relay connects it with the sender
5. WebRTC signaling happens (offer/answer/ICE via relay)
6. Data channel opens
7. Receives metadata message → shows file name and size
8. Receives binary chunks → accumulates in memory (for M1; streaming to disk is a later optimization)
9. Receives "done" message → triggers browser download of the complete file

### UI states:

1. **Connecting...** — "Looking for sender..."
2. **Sender not found** — "This link is no longer active. The sender may have closed the app or removed the file."
3. **Downloading** — Shows file name, progress bar, percentage, transfer speed
4. **Complete** — "Download complete!" with a "Save file" button (or auto-trigger download)
5. **Error** — "Transfer failed. The sender may have gone offline."

### Download trigger:

Once all chunks are received, create a Blob from the chunks, create an object URL, and trigger a download:

```js
const blob = new Blob(chunks);
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = fileName;
a.click();
```

### Styling:

- Centered card layout, max-width 480px
- Same dark theme as the Electron app
- Large progress bar during transfer
- Toss branding: just the name "Toss" at the top, small

### Relay URL:

- Same as the Electron app: `ws://localhost:3001` for dev

### IMPORTANT — no dependencies:

The receiver is vanilla HTML/CSS/JS. No frameworks, no build step. It must work in any modern browser.

---

## Task 5 — WebRTC Implementation Details ✅

This is the hardest part. Here are the specifics:

### In Electron (sender side):

- Use the renderer process's built-in WebRTC (Chromium provides `RTCPeerConnection` natively)
- The sender CREATES the offer when a recipient requests connection
- Flow:
  1. Relay says "someone wants shareId X"
  2. Sender creates `RTCPeerConnection` with STUN servers: `stun:stun.l.google.com:19302`
  3. Sender creates a data channel: `pc.createDataChannel('file')`
  4. Sender creates offer, sets local description
  5. Sends offer to recipient via relay
  6. Receives answer from recipient via relay, sets remote description
  7. ICE candidates exchanged via relay
  8. Data channel opens → start sending file

### In browser (recipient side):

- Browser has native WebRTC
- Recipient receives the offer, creates answer
- Flow:
  1. Receives offer from sender via relay
  2. Creates `RTCPeerConnection` with same STUN config
  3. Sets remote description (the offer)
  4. Creates answer, sets local description
  5. Sends answer back via relay
  6. ICE candidates exchanged
  7. `pc.ondatachannel` fires → listen for messages on the data channel
  8. Receive metadata, then chunks, then done

### STUN/TURN:

- Use Google's public STUN server for M1: `stun:stun.l.google.com:19302`
- No TURN server for M1 (means it won't work behind very restrictive NATs — acceptable for proof of concept)
- Add TURN support in M2 if needed

### Data channel config:

```js
const dc = pc.createDataChannel("file", {
  ordered: true, // chunks must arrive in order
  maxRetransmits: 30, // retry dropped packets
});
```

### Chunk size:

- 16KB chunks (16384 bytes)
- Monitor `dc.bufferedAmount` before sending next chunk to avoid overwhelming the buffer
- If `bufferedAmount > 1MB`, wait before sending more (use `dc.onbufferedamountlow`)
- Set `dc.bufferedAmountLowThreshold = 256 * 1024` (256KB)

---

## Task 6 — Development & Testing

### Running locally:

```bash
# Install deps first time
cd relay && npm install && cd ../app && npm install && cd ..

# Run everything
bin/dev
# → Relay on ws://localhost:3001, Receiver on http://localhost:3002, Electron app opens
# → Ctrl+C stops all
```

### Test flow:

1. Start relay
2. Start Electron app
3. Drag any file onto the app window
4. Copy the generated link
5. Open the link in a browser (Chrome/Firefox/Safari)
6. File should download in the browser directly from the Electron app

### Test cases to verify:

- [ ] Small file (<1MB) transfers successfully
- [ ] Medium file (~50MB) transfers with progress
- [ ] Removing a file from the app makes the link return "sender not found"
- [ ] Closing the Electron app makes all links dead
- [ ] Multiple files can be shared simultaneously
- [ ] Link works in Chrome, Firefox, Safari

---

## Constraints & Principles

- **No cloud storage** — files never leave the sender's machine
- **No accounts** — no auth, no sign-up, nothing
- **No build tools for M1** — no webpack, no vite, no typescript. Plain JS everywhere.
- **No external dependencies in the receiver** — vanilla JS only
- **Electron app dependencies should be minimal** — `ws` for WebSocket client, `electron` itself, that's about it
- **Keep the relay dumb** — it's a message forwarder, nothing more
- **Mac only** — don't worry about Windows packaging or testing for M1
- **Security is important but don't over-engineer for M1** — shareIds should be unguessable (UUID-based), but no auth tokens or encryption beyond what WebRTC provides natively (DTLS)
