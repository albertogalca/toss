// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const fileList = document.getElementById("file-list");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const fileCountEl = document.getElementById("file-count");
const emptyState = document.getElementById("empty-state");
const settingsBtn = document.getElementById("settings-btn");
const settingsPopover = document.getElementById("settings-popover");
const themeToggle = document.getElementById("theme-toggle");

// Active peer connections keyed by a unique session key (shareId + recipient)
const peerConnections = new Map();

// Concurrent download cap per shareId
const MAX_CONCURRENT = 5;
const activeTransfers = new Map(); // shareId -> count
const transferQueue = new Map();   // shareId -> [{ msg }]


// ICE servers (fetched from main process)
let iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

(async () => {
  try {
    const servers = await window.toss.getIceServers();
    if (servers && servers.length > 0) iceServers = servers;
  } catch (_) { /* use defaults */ }
})();

// ---------------------------------------------------------------------------
// Column resize
// ---------------------------------------------------------------------------

const fileTable = document.getElementById("file-table");

document.querySelectorAll(".col-resize").forEach((handle) => {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const col = handle.dataset.col;
    const th = handle.parentElement;
    const startX = e.clientX;
    const startWidth = th.offsetWidth;
    const tableWidth = fileTable.offsetWidth;

    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");

    const onMouseMove = (ev) => {
      const diff = ev.clientX - startX;
      const newPx = Math.max(40, startWidth + diff);
      const newPct = (newPx / tableWidth) * 100;
      fileTable.style.setProperty(`--col-${col}`, `${newPct}%`);
    };

    const onMouseUp = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getMimeType(fileName) {
  const ext = fileName.split(".").pop().toLowerCase();
  const map = {
    txt: "text/plain", html: "text/html", css: "text/css", js: "application/javascript",
    json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", svg: "image/svg+xml", pdf: "application/pdf",
    zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
  };
  return map[ext] || "application/octet-stream";
}

function updateFileCount() {
  const count = fileList.querySelectorAll("tr.file-row").length;
  fileCountEl.textContent = `${count} file${count !== 1 ? "s" : ""}`;
  emptyState.classList.toggle("hidden", count > 0);
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

window.toss.onConnectionStatus((connected) => {
  if (connected) {
    statusDot.classList.add("connected");
    statusText.textContent = "Connected";
  } else {
    statusDot.classList.remove("connected");
    statusText.textContent = "Disconnected";
  }
});

// ---------------------------------------------------------------------------
// Drag & drop — entire body is the drop target
// ---------------------------------------------------------------------------

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("drag-over");
});

document.addEventListener("dragleave", (e) => {
  // Only remove when leaving the window
  if (e.relatedTarget === null) {
    document.body.classList.remove("drag-over");
  }
});

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("drag-over");

  for (const file of e.dataTransfer.files) {
    const filePath = window.toss.getPathForFile(file);
    if (!filePath) continue;

    const result = await window.toss.addFile(filePath);
    addFileToUI(result);
  }
});

// ---------------------------------------------------------------------------
// Row selection & keyboard navigation
// ---------------------------------------------------------------------------

function selectRow(tr) {
  if (!tr || !tr.classList.contains("file-row")) return;
  const prev = fileList.querySelector("tr.file-row.selected");
  if (prev) prev.classList.remove("selected");
  tr.classList.add("selected");
  tr.scrollIntoView({ block: "nearest" });
}

function getSelectedRow() {
  return fileList.querySelector("tr.file-row.selected");
}

function getFileRows() {
  return [...fileList.querySelectorAll("tr.file-row")];
}

async function removeRow(tr) {
  const id = tr.id.replace("file-", "");
  // Select neighbor before removing
  const rows = getFileRows();
  const idx = rows.indexOf(tr);
  const next = rows[idx + 1] || rows[idx - 1];

  await window.toss.removeFile(id);
  const pwRow = document.getElementById(`pw-row-${id}`);
  if (pwRow) pwRow.remove();
  tr.remove();

  updateFileCount();

  if (next) selectRow(next);
}

document.addEventListener("keydown", (e) => {
  // Don't intercept when typing in an input
  if (e.target.tagName === "INPUT") return;

  const selected = getSelectedRow();
  const rows = getFileRows();
  if (rows.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!selected) { selectRow(rows[0]); return; }
    const idx = rows.indexOf(selected);
    if (idx < rows.length - 1) selectRow(rows[idx + 1]);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (!selected) { selectRow(rows[rows.length - 1]); return; }
    const idx = rows.indexOf(selected);
    if (idx > 0) selectRow(rows[idx - 1]);
  } else if ((e.key === "Backspace" || e.key === "Delete") && selected) {
    e.preventDefault();
    removeRow(selected);
  }
});

// ---------------------------------------------------------------------------
// File list UI
// ---------------------------------------------------------------------------

async function addFileToUI({ shareId, fileName, fileSize, hasPassword }) {
  const url = await window.toss.getShareUrl(shareId);

  const tr = document.createElement("tr");
  tr.className = "file-row";
  tr.id = `file-${shareId}`;

  tr.innerHTML = `
    <td class="col-name-cell" title="${fileName}">
      ${fileName}
      <div class="row-progress"><div class="row-progress-fill" id="progress-${shareId}"></div></div>
    </td>
    <td class="col-size-cell">${humanSize(fileSize)}</td>
    <td class="col-status-cell"><span class="status-text" id="status-${shareId}">Ready</span></td>
    <td class="col-actions-cell">
      <button class="copy" data-url="${url}" title="Copy link">&#x27A4;</button>
      <button class="pw-toggle" data-id="${shareId}" title="Password">${hasPassword ? "&#x1F512;" : "&#x1F513;"}</button>
      <button class="remove" data-id="${shareId}" title="Remove">&#x2715;</button>
    </td>
  `;

  // Click to select row
  tr.addEventListener("click", () => selectRow(tr));

  // Copy link
  tr.querySelector(".copy").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    await navigator.clipboard.writeText(btn.dataset.url);
    const orig = btn.innerHTML;
    btn.textContent = "\u2713";
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  });

  // Password toggle
  tr.querySelector(".pw-toggle").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const id = btn.dataset.id;
    const currentPassword = await window.toss.getFilePassword(id);

    if (currentPassword) {
      await window.toss.setFilePassword(id, null);
      btn.innerHTML = "&#x1F513;";
      const pwRow = document.getElementById(`pw-row-${id}`);
      if (pwRow) pwRow.remove();
    } else {
      let pwRow = document.getElementById(`pw-row-${id}`);
      if (pwRow) { pwRow.querySelector("input").focus(); return; }

      pwRow = document.createElement("tr");
      pwRow.className = "password-row-tr";
      pwRow.id = `pw-row-${id}`;
      pwRow.innerHTML = `
        <td colspan="4">
          <div class="password-inline">
            <input type="password" placeholder="Set password" />
            <button class="pw-save">Set</button>
            <button class="pw-cancel">Cancel</button>
          </div>
        </td>
      `;
      tr.after(pwRow);

      const input = pwRow.querySelector("input");
      input.focus();

      const save = () => {
        const pw = input.value.trim();
        if (pw) {
          window.toss.setFilePassword(id, pw);
          btn.innerHTML = "&#x1F512;";
        }
        pwRow.remove();
      };

      pwRow.querySelector(".pw-save").addEventListener("click", save);
      pwRow.querySelector(".pw-cancel").addEventListener("click", () => pwRow.remove());
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") save();
        if (ev.key === "Escape") pwRow.remove();
      });
    }
  });

  // Remove
  tr.querySelector(".remove").addEventListener("click", () => removeRow(tr));

  fileList.appendChild(tr);
  updateFileCount();
}

// ---------------------------------------------------------------------------
// Transfer progress
// ---------------------------------------------------------------------------

window.toss.onTransferProgress(({ shareId, sent, total }) => {
  const pct = Math.round((sent / total) * 100);
  const bar = document.getElementById(`progress-${shareId}`);
  const status = document.getElementById(`status-${shareId}`);
  if (bar) {
    bar.parentElement.classList.add("active");
    bar.style.width = `${pct}%`;
  }
  if (status) status.textContent = `${pct}%`;
});

// ---------------------------------------------------------------------------
// Concurrent transfer management
// ---------------------------------------------------------------------------

function getActiveCount(shareId) {
  return activeTransfers.get(shareId) || 0;
}

function incrementActive(shareId) {
  activeTransfers.set(shareId, getActiveCount(shareId) + 1);
}

function decrementActive(shareId) {
  const count = Math.max(0, getActiveCount(shareId) - 1);
  if (count === 0) activeTransfers.delete(shareId);
  else activeTransfers.set(shareId, count);

  // Dequeue next waiting request
  const queue = transferQueue.get(shareId);
  if (queue && queue.length > 0) {
    const next = queue.shift();
    if (queue.length === 0) transferQueue.delete(shareId);
    startTransfer(next);
  }
}

function enqueueOrStart(msg) {
  const { shareId } = msg;
  if (getActiveCount(shareId) < MAX_CONCURRENT) {
    startTransfer(msg);
  } else {
    if (!transferQueue.has(shareId)) transferQueue.set(shareId, []);
    transferQueue.get(shareId).push(msg);
  }
}

// ---------------------------------------------------------------------------
// WebRTC sender logic (runs in renderer — Chromium WebRTC)
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 64 * 1024; // 64 KB
const HIGH_WATER = 4 * 1024 * 1024; // 4 MB
const LOW_WATER = 512 * 1024; // 512 KB

window.toss.onIncomingRequest(async (msg) => {
  if (msg.type === "recipient-ready") {
    enqueueOrStart(msg);
  } else if (msg.type === "signal") {
    const data = msg.data;
    if (data.type === "answer") {
      handleAnswer({ shareId: msg.shareId, sessionId: msg.sessionId, sdp: data.sdp });
    } else if (data.type === "ice-candidate") {
      handleRemoteICE({ shareId: msg.shareId, sessionId: msg.sessionId, candidate: data.candidate });
    }
  }
});

async function startTransfer(msg) {
  const { shareId, sessionId } = msg;
  const key = `${shareId}:${sessionId}`;

  incrementActive(shareId);

  // Fetch file info
  const files = await window.toss.getFiles();
  const fileInfo = files.find((f) => f.shareId === shareId);
  if (!fileInfo) {
    decrementActive(shareId);
    return;
  }

  const pc = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 1,
  });

  peerConnections.set(key, pc);

  // ICE candidates -> relay (extract plain object — RTCIceCandidate doesn't survive IPC)
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      window.toss.sendSignal(shareId, sessionId, {
        type: "ice-candidate",
        candidate: e.candidate.toJSON(),
      });
    }
  };

  // Create data channel
  const dc = pc.createDataChannel("file", {
    ordered: true,
  });

  dc.binaryType = "arraybuffer";

  let sent = false;

  dc.onopen = async () => {
    // Check if file has a password — if so, do auth handshake first
    const files = await window.toss.getFiles();
    const hasPassword = files.find((f) => f.shareId === shareId)?.hasPassword;
    if (hasPassword) {
      dc.send(JSON.stringify({ type: "auth-required" }));
      // Wait for correct password, allowing retries
      const authOk = await new Promise((resolve) => {
        const maxAttempts = 5;
        let attempts = 0;
        const timeout = setTimeout(() => resolve(false), 120000); // 2 min total
        dc.onmessage = async (event) => {
          if (typeof event.data !== "string") return;
          try {
            const authMsg = JSON.parse(event.data);
            if (authMsg.type === "auth") {
              attempts++;
              const match = await window.toss.verifyPassword(shareId, authMsg.password);
              if (match) {
                dc.send(JSON.stringify({ type: "auth-ok" }));
                clearTimeout(timeout);
                resolve(true);
              } else if (attempts >= maxAttempts) {
                dc.send(JSON.stringify({ type: "auth-failed" }));
                clearTimeout(timeout);
                resolve(false);
              } else {
                dc.send(JSON.stringify({ type: "auth-failed" }));
                // Keep listening for next attempt
              }
            }
          } catch (_) { /* ignore */ }
        };
      });
      if (!authOk || dc.readyState !== "open") {
        dc.close();
        pc.close();
        peerConnections.delete(key);
        decrementActive(shareId);
        updateStatus(shareId, "Auth failed");
        return;
      }
    }

    updateStatus(shareId, "Sending...");

    // Send metadata
    dc.send(JSON.stringify({
      type: "metadata",
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
      mimeType: getMimeType(fileInfo.fileName),
    }));

    // Stream file in chunks
    let offset = 0;
    const total = fileInfo.fileSize;

    while (offset < total) {
      // Receiver may have closed the channel (e.g. HTTP download succeeded)
      if (dc.readyState !== "open") break;

      // Back-pressure: wait if buffer is too full
      if (dc.bufferedAmount > HIGH_WATER) {
        await waitForDrain(dc);
        if (dc.readyState !== "open") break;
      }

      const length = Math.min(CHUNK_SIZE, total - offset);
      const chunk = await window.toss.readFileChunk(shareId, offset, length);
      if (!chunk) break;

      try {
        dc.send(chunk);
      } catch (_) {
        break; // channel closed mid-send
      }
      offset += chunk.byteLength;

      // Update progress
      const pct = Math.round((offset / total) * 100);
      const bar = document.getElementById(`progress-${shareId}`);
      const status = document.getElementById(`status-${shareId}`);
      if (bar) {
        bar.parentElement.classList.add("active");
        bar.style.width = `${pct}%`;
      }
      if (status) status.textContent = `${pct}%`;
    }

    if (dc.readyState !== "open") {
      // Receiver closed channel — likely used HTTP instead
      pc.close();
      peerConnections.delete(key);
      decrementActive(shareId);
      updateStatus(shareId, "Ready");
      return;
    }

    // Signal done
    dc.send(JSON.stringify({ type: "done" }));
    sent = true;
    updateStatus(shareId, "Sent");

    // Clean up after a short delay
    setTimeout(() => {
      pc.close();
      peerConnections.delete(key);
      decrementActive(shareId);
    }, 2000);
  };

  dc.onerror = () => {
    if (!sent) {
      updateStatus(shareId, "Error");
      decrementActive(shareId);
    }
  };

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Extract plain object — RTCSessionDescription doesn't survive IPC structured clone
  window.toss.sendSignal(shareId, sessionId, {
    type: "offer",
    sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
  });
}

async function handleAnswer(msg) {
  const pc = peerConnections.get(`${msg.shareId}:${msg.sessionId}`);
  if (!pc) return;

  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
}

async function handleRemoteICE(msg) {
  const pc = peerConnections.get(`${msg.shareId}:${msg.sessionId}`);
  if (!pc) return;

  try {
    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  } catch (_) {
    // ignore ICE errors
  }
}

function waitForDrain(dc) {
  return new Promise((resolve) => {
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onbufferedamountlow = () => {
      dc.onbufferedamountlow = null;
      resolve();
    };
  });
}

function updateStatus(shareId, text) {
  const status = document.getElementById(`status-${shareId}`);
  if (status) status.textContent = text;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPopover.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (!settingsPopover.contains(e.target) && e.target !== settingsBtn) {
    settingsPopover.classList.remove("open");
  }
});

themeToggle.addEventListener("change", () => {
  const theme = themeToggle.checked ? "light" : "dark";
  document.body.classList.toggle("light", themeToggle.checked);
  window.toss.setPreferences({ theme });
});

// ---------------------------------------------------------------------------
// Init — reload existing files on startup + apply preferences
// ---------------------------------------------------------------------------

(async () => {
  const prefs = await window.toss.getPreferences();
  if (prefs.theme === "light") {
    document.body.classList.add("light");
    themeToggle.checked = true;
  }

  const files = await window.toss.getFiles();
  for (const f of files) {
    addFileToUI(f);
  }
})();
