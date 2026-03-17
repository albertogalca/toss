const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3001;
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const TURN_SERVER = process.env.TURN_SERVER;
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_TTL = parseInt(process.env.TURN_TTL, 10) || 86400; // 24h default

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_RECIPIENTS_PER_ROOM = 10;
const MAX_ROOMS = 10000;
const MAX_IP_ENTRIES = 50000;
const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SHARE_ID_RE = /^[A-Za-z0-9_-]{10,24}$/;

// shareId -> { sender: ws, recipients: Map<sessionId, ws>, lastActivity }
const rooms = new Map();
// ws -> Set<shareId>  (tracks all shareIds registered by a sender)
const senderShareIds = new Map();
// ws -> [{shareId, sessionId}]  (tracks rooms a recipient joined, for fast cleanup)
const recipientRooms = new Map();

// ---------------------------------------------------------------------------
// Rate limiting — token bucket per IP
// ---------------------------------------------------------------------------

const RATE_LIMIT_PER_SEC = 50;
const RATE_LIMIT_BUCKET = 100;
const MAX_CONNECTIONS_PER_IP = 20;

// ip -> { tokens, lastRefill, connections }
const ipState = new Map();

function getIpState(ip) {
  let state = ipState.get(ip);
  if (!state) {
    if (ipState.size >= MAX_IP_ENTRIES) return null;
    state = { tokens: RATE_LIMIT_BUCKET, lastRefill: Date.now(), connections: 0 };
    ipState.set(ip, state);
  }
  return state;
}

function consumeToken(ip) {
  const state = getIpState(ip);
  if (!state) return false;
  const now = Date.now();
  const elapsed = (now - state.lastRefill) / 1000;
  state.tokens = Math.min(RATE_LIMIT_BUCKET, state.tokens + elapsed * RATE_LIMIT_PER_SEC);
  state.lastRefill = now;

  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
}

// Prune stale IP entries and idle rooms every 60s
setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of ipState) {
    if (state.connections === 0 && now - state.lastRefill > 120_000) {
      ipState.delete(ip);
    }
  }
  // Sweep rooms idle > ROOM_TTL_MS
  for (const [shareId, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      for (const recipientWs of room.recipients.values()) {
        send(recipientWs, { type: "error", message: "room expired" });
      }
      send(room.sender, { type: "error", message: "room expired" });
      rooms.delete(shareId);
      const ids = senderShareIds.get(room.sender);
      if (ids) ids.delete(shareId);
    }
  }
}, 60_000);

function validateShareId(ws, shareId) {
  if (!shareId) {
    send(ws, { type: "error", message: "missing shareId" });
    return false;
  }
  if (!SHARE_ID_RE.test(shareId)) {
    send(ws, { type: "error", message: "invalid shareId format" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTTP server (TLS if certs provided)
// ---------------------------------------------------------------------------

function handleRequest(req, res) {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    let activeConnections = 0;
    if (wss) activeConnections = wss.clients.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      activeConnections,
      activeRooms: rooms.size,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/ice-config") {
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];

    if (TURN_SERVER && TURN_SECRET) {
      const username = Math.floor(Date.now() / 1000 + TURN_TTL).toString();
      const hmac = crypto.createHmac("sha1", TURN_SECRET);
      hmac.update(username);
      const credential = hmac.digest("base64");

      iceServers.push({
        urls: TURN_SERVER,
        username,
        credential,
      });
    }

    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOWED_ORIGIN });
    res.end(JSON.stringify({ iceServers }));
    return;
  }

  res.writeHead(404);
  res.end();
}

let server;
if (TLS_CERT && TLS_KEY) {
  server = https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, handleRequest);
} else {
  server = http.createServer(handleRequest);
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
  const state = getIpState(ip);

  if (!state) {
    ws.close(4503, "server busy");
    return;
  }

  // Connection limit per IP
  if (state.connections >= MAX_CONNECTIONS_PER_IP) {
    ws.close(4429, "too many connections");
    return;
  }
  state.connections += 1;

  console.log(`[connect] client connected from ${ip} (total: ${wss.clients.size})`);

  ws.on("message", (raw) => {
    // Rate limit per message
    if (!consumeToken(ip)) {
      return send(ws, { type: "error", message: "rate limit exceeded" });
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: "error", message: "invalid JSON" });
    }

    const { type, shareId, data } = msg;

    switch (type) {
      case "register": {
        if (!validateShareId(ws, shareId)) return;

        if (rooms.size >= MAX_ROOMS && !rooms.has(shareId)) {
          return send(ws, { type: "error", message: "server full" });
        }

        rooms.set(shareId, {
          sender: ws,
          recipients: new Map(),
          httpEndpoints: msg.httpEndpoints || [],
          hasPassword: !!msg.hasPassword,
          fileName: msg.fileName || null,
          fileSize: msg.fileSize || 0,
          lastActivity: Date.now(),
        });

        if (!senderShareIds.has(ws)) senderShareIds.set(ws, new Set());
        senderShareIds.get(ws).add(shareId);

        console.log(`[register] shareId=${shareId} httpEndpoints=${(msg.httpEndpoints || []).length}`);
        break;
      }

      case "unregister": {
        if (!validateShareId(ws, shareId)) return;

        const room = rooms.get(shareId);
        if (room && room.sender === ws) {
          // Notify all recipients
          for (const recipientWs of room.recipients.values()) {
            send(recipientWs, { type: "error", message: "sender unregistered" });
          }
          rooms.delete(shareId);
          const ids = senderShareIds.get(ws);
          if (ids) ids.delete(shareId);
        }

        console.log(`[unregister] shareId=${shareId}`);
        break;
      }

      case "request": {
        if (!validateShareId(ws, shareId)) return;
        const sessionId = msg.sessionId;
        if (!sessionId) return send(ws, { type: "error", message: "missing sessionId" });

        const room = rooms.get(shareId);
        if (!room) {
          return send(ws, { type: "error", message: "shareId not found" });
        }

        // Recipient cap per room
        if (room.recipients.size >= MAX_RECIPIENTS_PER_ROOM) {
          return send(ws, { type: "error", message: "too many recipients" });
        }

        room.lastActivity = Date.now();
        room.recipients.set(sessionId, ws);
        if (!recipientRooms.has(ws)) recipientRooms.set(ws, []);
        recipientRooms.get(ws).push({ shareId, sessionId });
        // Let sender know a recipient connected
        send(room.sender, { type: "recipient-ready", shareId, sessionId });
        // Send file info + HTTP endpoints to recipient
        send(ws, {
          type: "file-info",
          shareId,
          fileName: room.fileName,
          fileSize: room.fileSize,
          hasPassword: room.hasPassword,
          httpEndpoints: room.httpEndpoints || [],
        });
        console.log(`[request] recipient joined shareId=${shareId} sessionId=${sessionId}`);
        break;
      }

      case "signal": {
        if (!validateShareId(ws, shareId)) return;
        const sessionId = msg.sessionId;
        if (!sessionId) return send(ws, { type: "error", message: "missing sessionId" });

        const room = rooms.get(shareId);
        if (!room) {
          return send(ws, { type: "error", message: "shareId not found" });
        }

        room.lastActivity = Date.now();

        // Forward to the other party, routing by sessionId
        if (ws === room.sender) {
          const recipient = room.recipients.get(sessionId);
          if (recipient) {
            send(recipient, { type: "signal", shareId, sessionId, data });
          } else {
            send(ws, { type: "error", message: "no peer connected" });
          }
        } else {
          // recipient -> sender
          send(room.sender, { type: "signal", shareId, sessionId, data });
        }
        break;
      }

      default:
        send(ws, { type: "error", message: `unknown type: ${type}` });
    }
  });

  ws.on("close", () => {
    state.connections = Math.max(0, state.connections - 1);
    console.log(`[disconnect] client disconnected (total: ${wss.clients.size})`);

    // If this was a sender, clean up all its shareIds
    const ids = senderShareIds.get(ws);
    if (ids) {
      for (const shareId of ids) {
        const room = rooms.get(shareId);
        if (room) {
          for (const recipientWs of room.recipients.values()) {
            send(recipientWs, { type: "error", message: "sender disconnected" });
          }
          rooms.delete(shareId);
        }
      }
      senderShareIds.delete(ws);
    }

    // If this was a recipient in any room, remove it via reverse map
    const entries = recipientRooms.get(ws);
    if (entries) {
      for (const { shareId, sessionId } of entries) {
        const room = rooms.get(shareId);
        if (room) {
          room.recipients.delete(sessionId);
          console.log(`[cleanup] recipient left shareId=${shareId} sessionId=${sessionId}`);
        }
      }
      recipientRooms.delete(ws);
    }
  });
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function shutdown() {
  console.log("shutting down...");
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, () => {
  const proto = (TLS_CERT && TLS_KEY) ? "wss" : "ws";
  console.log(`toss relay listening on port ${PORT} (${proto})`);
});
