const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const os = require("os");
const WebSocket = require("ws");

// Use real IPs instead of mDNS .local hostnames for WebRTC ICE candidates
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");

const RELAY_URL = process.env.RELAY_URL || "ws://localhost:3001";
const RECEIVER_URL = process.env.RECEIVER_URL || "http://localhost:3002";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function corsHeaders(extra) {
  return Object.assign({ "Access-Control-Allow-Origin": ALLOWED_ORIGIN }, extra || {});
}

// Shared files map: shareId -> { filePath, fileName, fileSize, password? }
const sharedFiles = new Map();
const SHARED_FILES_PATH = path.join(app.getPath("userData"), "shared-files.json");

// ICE servers fetched from relay
let iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function saveSharedFiles() {
  const data = [];
  for (const [shareId, info] of sharedFiles) {
    data.push({
      shareId,
      filePath: info.filePath,
      fileName: info.fileName,
      fileSize: info.fileSize,
      password: info.password || null,
    });
  }
  fs.writeFileSync(SHARED_FILES_PATH, JSON.stringify(data), "utf8");
}

function loadSharedFiles() {
  if (!fs.existsSync(SHARED_FILES_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(SHARED_FILES_PATH, "utf8"));
    for (const entry of data) {
      if (fs.existsSync(entry.filePath)) {
        sharedFiles.set(entry.shareId, {
          filePath: entry.filePath,
          fileName: entry.fileName,
          fileSize: entry.fileSize,
          password: entry.password || null,
        });
      }
    }
  } catch (err) { console.error("Failed to load shared files:", err.message); }
}

async function fetchIceConfig() {
  try {
    const httpUrl = RELAY_URL.replace(/^ws/, "http");
    const res = await fetch(`${httpUrl}/ice-config`);
    if (res.ok) {
      const config = await res.json();
      if (config.iceServers && config.iceServers.length > 0) {
        iceServers = config.iceServers;
      }
    }
  } catch (err) { console.error("Failed to fetch ICE config:", err.message); }
}

let mainWindow = null;
let ws = null;
let wsConnected = false;
let reconnectTimer = null;

// ---------------------------------------------------------------------------
// HTTP file server for direct LAN downloads
// ---------------------------------------------------------------------------

let httpServer = null;
let httpPort = 0;

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.internal) continue;
      if (iface.family === "IPv4") {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function getHttpEndpoints() {
  if (!httpPort) return [];
  const endpoints = [`http://127.0.0.1:${httpPort}`];
  for (const ip of getLocalIPs()) {
    endpoints.push(`http://${ip}:${httpPort}`);
  }
  return endpoints;
}

function startHttpServer() {
  return new Promise((resolve) => {
    httpServer = http.createServer((req, res) => {
      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders({
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        }));
        res.end();
        return;
      }

      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }

      // Parse URL: /download/:shareId?token=...
      const url = new URL(req.url, `http://localhost:${httpPort}`);
      const match = url.pathname.match(/^\/download\/(.+)$/);
      if (!match) {
        res.writeHead(404);
        res.end();
        return;
      }

      const shareId = decodeURIComponent(match[1]);
      const info = sharedFiles.get(shareId);
      if (!info) {
        res.writeHead(404, corsHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      // Password check
      if (info.password) {
        const token = url.searchParams.get("token");
        const expected = crypto.createHash("sha256").update(info.password).digest("hex");
        if (token !== expected) {
          res.writeHead(403, corsHeaders({ "Content-Type": "application/json" }));
          res.end(JSON.stringify({ error: "invalid token" }));
          return;
        }
      }

      // Check file still exists
      if (!fs.existsSync(info.filePath)) {
        res.writeHead(410, corsHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: "file gone" }));
        return;
      }

      // Stream file
      const mimeType = guessMimeType(info.fileName);
      res.writeHead(200, corsHeaders({
        "Content-Type": mimeType,
        "Content-Length": info.fileSize,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(info.fileName)}"`,
        "Access-Control-Expose-Headers": "Content-Length, Content-Disposition",
      }));

      const stream = fs.createReadStream(info.filePath);
      stream.pipe(res);
      stream.on("error", () => {
        res.destroy();
      });
    });

    httpServer.listen(0, () => {
      httpPort = httpServer.address().port;
      console.log(`[http] file server listening on port ${httpPort}`);
      resolve();
    });
  });
}

function guessMimeType(fileName) {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const types = {
    pdf: "application/pdf", zip: "application/zip", gz: "application/gzip",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    txt: "text/plain", html: "text/html", css: "text/css", js: "text/javascript",
    json: "application/json", xml: "application/xml",
  };
  return types[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 600,
    titleBarStyle: "default",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // required for file.path on drag-and-drop
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Relay WebSocket
// ---------------------------------------------------------------------------

function connectRelay() {
  if (ws) {
    try { ws.close(); } catch (_) { /* ignore */ }
  }

  ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    wsConnected = true;
    sendStatus();
    // Re-register every shared file
    for (const shareId of sharedFiles.keys()) {
      registerWithRelay(shareId);
    }
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      handleRelayMessage(msg);
    } catch (_) { /* ignore malformed */ }
  });

  ws.on("close", () => {
    wsConnected = false;
    sendStatus();
    scheduleReconnect();
  });

  ws.on("error", () => {
    wsConnected = false;
    sendStatus();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRelay();
  }, 3000);
}

function sendStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("connection-status", wsConnected);
  }
}

function relaySend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function registerWithRelay(shareId) {
  const info = sharedFiles.get(shareId);
  if (!info) return;
  relaySend({
    type: "register",
    shareId,
    httpEndpoints: getHttpEndpoints(),
    hasPassword: !!info.password,
    fileName: info.fileName,
    fileSize: info.fileSize,
  });
}

function unregisterWithRelay(shareId) {
  relaySend({ type: "unregister", shareId });
}

function handleRelayMessage(msg) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (msg.type === "recipient-ready") {
    // Relay tells us a recipient wants a file — tell renderer to start WebRTC
    mainWindow.webContents.send("incoming-request", {
      type: "recipient-ready",
      shareId: msg.shareId,
      sessionId: msg.sessionId,
    });
  } else if (msg.type === "signal") {
    // Relay forwards signaling data from recipient — unwrap and forward
    mainWindow.webContents.send("incoming-request", {
      type: "signal",
      shareId: msg.shareId,
      sessionId: msg.sessionId,
      data: msg.data,
    });
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

ipcMain.handle("add-file", (_event, filePath, password) => {
  const shareId = crypto.randomBytes(12).toString("base64url"); // 16 chars, 96 bits
  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  sharedFiles.set(shareId, { filePath, fileName, fileSize, password: password || null });
  saveSharedFiles();
  registerWithRelay(shareId);

  return { shareId, fileName, fileSize };
});

ipcMain.handle("remove-file", (_event, shareId) => {
  unregisterWithRelay(shareId);
  sharedFiles.delete(shareId);
  saveSharedFiles();
});

ipcMain.handle("get-files", () => {
  const result = [];
  for (const [shareId, info] of sharedFiles) {
    result.push({
      shareId,
      fileName: info.fileName,
      fileSize: info.fileSize,
      hasPassword: !!info.password,
    });
  }
  return result;
});

ipcMain.handle("get-file-password", (_event, shareId) => {
  const info = sharedFiles.get(shareId);
  return info ? info.password : null;
});

ipcMain.handle("set-file-password", (_event, shareId, password) => {
  const info = sharedFiles.get(shareId);
  if (info) {
    info.password = password || null;
    saveSharedFiles();
  }
});

ipcMain.handle("get-share-url", (_event, shareId) => {
  return `${RECEIVER_URL}/#/${shareId}`;
});

ipcMain.handle("get-connection-status", () => {
  return wsConnected;
});

ipcMain.handle("send-signal", (_event, shareId, sessionId, data) => {
  relaySend({ type: "signal", shareId, sessionId, data });
});

ipcMain.handle("read-file-chunk", (_event, shareId, offset, length) => {
  const info = sharedFiles.get(shareId);
  if (!info) return null;

  let fd;
  try {
    fd = fs.openSync(info.filePath, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } catch (err) {
    console.error("read-file-chunk failed:", err.message);
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
});

ipcMain.handle("verify-password", (_event, shareId, candidatePassword) => {
  const info = sharedFiles.get(shareId);
  if (!info || !info.password) return false;
  const expected = Buffer.from(info.password, "utf8");
  const candidate = Buffer.from(String(candidatePassword), "utf8");
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(expected, candidate);
});

ipcMain.handle("get-ice-servers", () => {
  return iceServers;
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  loadSharedFiles();
  createWindow();
  await startHttpServer();
  await fetchIceConfig();
  connectRelay();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch (_) { /* ignore */ }
  }
  if (httpServer) {
    try { httpServer.close(); } catch (_) { /* ignore */ }
  }
});
