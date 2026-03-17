(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────────
  var RELAY_URL = window.TOSS_RELAY_URL || "ws://localhost:3001";

  // ── DOM refs ────────────────────────────────────────────────────────
  var stateConnecting = document.getElementById("state-connecting");
  var stateNotFound = document.getElementById("state-not-found");
  var statePassword = document.getElementById("state-password");
  var stateDownloading = document.getElementById("state-downloading");
  var stateComplete = document.getElementById("state-complete");
  var stateError = document.getElementById("state-error");

  var elFileName = document.getElementById("file-name");
  var elFileSize = document.getElementById("file-size");
  var elProgressFill = document.getElementById("progress-fill");
  var elProgressPercent = document.getElementById("progress-percent");
  var elTransferSpeed = document.getElementById("transfer-speed");
  var elCompleteFileName = document.getElementById("complete-file-name");
  var elErrorDetail = document.getElementById("error-detail");
  var elPasswordInput = document.getElementById("password-input");
  var elPasswordSubmit = document.getElementById("password-submit");
  var elPasswordError = document.getElementById("password-error");

  // ── Helpers ─────────────────────────────────────────────────────────

  var allStates = [stateConnecting, stateNotFound, statePassword, stateDownloading, stateComplete, stateError];

  function showState(el) {
    allStates.forEach(function (s) { s.classList.add("hidden"); });
    el.classList.remove("hidden");
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function extractShareId() {
    var hash = location.hash;
    if (!hash) return null;
    var match = hash.match(/^#\/(.+)$/);
    return match ? match[1] : null;
  }

  var supportsFileSystemAccess = typeof window.showSaveFilePicker === "function";

  // Reload on hash change so a new shareId gets a clean session
  window.addEventListener("hashchange", function () { location.reload(); });

  // ── Main ────────────────────────────────────────────────────────────

  var shareId = extractShareId();
  if (!shareId) {
    showState(stateNotFound);
    return;
  }

  var sessionId = Array.from(crypto.getRandomValues(new Uint8Array(8)),
    function(b) { return b.toString(16).padStart(2, "0"); }).join("");

  var ws;
  var pc;
  var dataChannel = null;
  var receivedChunks = [];
  var receivedBytes = 0;
  var metadata = null;
  var speedStartTime = 0;
  var speedStartBytes = 0;
  var speedInterval = null;
  var iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // Streaming download state
  var fileWriter = null;     // FileSystemWritableFileStream
  var useStreaming = false;

  function showError(message) {
    if (message) elErrorDetail.textContent = message;
    showState(stateError);
    cleanup();
  }

  function cleanup() {
    if (speedInterval) clearInterval(speedInterval);
    if (fileWriter) {
      try { fileWriter.close(); } catch (_) {}
      fileWriter = null;
    }
    if (pc) {
      try { pc.close(); } catch (_) {}
      pc = null;
    }
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
  }

  function triggerDownload(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function updateProgress() {
    if (!metadata || !metadata.fileSize) return;
    var pct = Math.min(100, (receivedBytes / metadata.fileSize) * 100);
    elProgressFill.style.width = pct.toFixed(1) + "%";
    elProgressPercent.textContent = pct.toFixed(1) + "%";
  }

  function updateSpeed() {
    var now = Date.now();
    var elapsed = (now - speedStartTime) / 1000;
    if (elapsed < 0.5) return;
    var bytesPerSec = (receivedBytes - speedStartBytes) / elapsed;
    elTransferSpeed.textContent = formatBytes(bytesPerSec) + "/s";
    speedStartTime = now;
    speedStartBytes = receivedBytes;
  }

  // ── Password auth ──────────────────────────────────────────────────

  var pendingAuthResolve = null;

  function waitForPassword() {
    showState(statePassword);
    elPasswordError.classList.add("hidden");
    elPasswordInput.value = "";
    elPasswordInput.focus();

    return new Promise(function (resolve) {
      pendingAuthResolve = resolve;
    });
  }

  elPasswordSubmit.addEventListener("click", function () {
    if (pendingAuthResolve) {
      var pw = elPasswordInput.value;
      pendingAuthResolve(pw);
      pendingAuthResolve = null;
    }
  });

  elPasswordInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && pendingAuthResolve) {
      var pw = elPasswordInput.value;
      pendingAuthResolve(pw);
      pendingAuthResolve = null;
    }
  });

  // ── Data channel handling ──────────────────────────────────────────

  function setupDataChannel(channel) {
    // If HTTP download already succeeded, ignore the data channel entirely
    if (httpDownloadSucceeded) {
      try { channel.close(); } catch (_) {}
      return;
    }

    dataChannel = channel;
    channel.binaryType = "arraybuffer";

    var awaitingAuth = false;

    channel.onmessage = function (event) {
      // Binary chunk
      if (event.data instanceof ArrayBuffer) {
        receivedBytes += event.data.byteLength;

        if (useStreaming && fileWriter) {
          fileWriter.write(new Uint8Array(event.data)).catch(function () {});
        } else {
          receivedChunks.push(event.data);
        }

        updateProgress();
        return;
      }

      // Text message (JSON)
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (msg.type === "auth-required") {
        awaitingAuth = true;
        handleAuth(channel);
        return;
      }

      if (msg.type === "auth-ok") {
        awaitingAuth = false;
        return;
      }

      if (msg.type === "auth-failed") {
        // Show error, let user retry
        elPasswordError.classList.remove("hidden");
        showState(statePassword);
        // Re-trigger auth
        handleAuth(channel);
        return;
      }

      if (msg.type === "metadata") {
        metadata = msg;
        elFileName.textContent = msg.fileName || "Unknown file";
        elFileSize.textContent = formatBytes(msg.fileSize || 0);
        showState(stateDownloading);

        speedStartTime = Date.now();
        speedStartBytes = 0;
        speedInterval = setInterval(updateSpeed, 1000);

        // Decide streaming vs in-memory
        var fileSize = msg.fileSize || 0;

        if (supportsFileSystemAccess && fileSize > 100 * 1024 * 1024) {
          // Large file: use File System Access API for disk streaming
          promptForStreamingDownload(msg.fileName, msg.mimeType);
        } else if (!supportsFileSystemAccess) {
          // No File System Access API — warn for large files
          if (fileSize > 4 * 1024 * 1024 * 1024) {
            showError("File is too large for this browser (>4GB). Use Chrome or Edge for large file support.");
            return;
          }
          if (fileSize > 2 * 1024 * 1024 * 1024) {
            console.warn("[receiver] File >2GB — may run out of memory in this browser.");
          }
        }
      } else if (msg.type === "done") {
        if (speedInterval) clearInterval(speedInterval);

        if (useStreaming && fileWriter) {
          // Streaming complete — file already on disk
          fileWriter.close().then(function () {
            fileWriter = null;
            var fileName = (metadata && metadata.fileName) || "download";
            elCompleteFileName.textContent = fileName;
            document.getElementById("complete-file-size").textContent = formatBytes(receivedBytes);
            showState(stateComplete);

            // No preview or download button needed for streamed files
            var previewContainer = document.getElementById("preview-container");
            previewContainer.innerHTML =
              '<div class="file-placeholder">' +
                '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">' +
                  '<path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />' +
                '</svg>' +
                '<span class="file-type-label">Saved to disk</span>' +
              '</div>';

            // Hide download button for streamed files
            document.getElementById("download-btn").style.display = "none";

            cleanup();
          });
          return;
        }

        // In-memory download
        var mimeType = (metadata && metadata.mimeType) || "application/octet-stream";
        var blob = new Blob(receivedChunks, { type: mimeType });
        var fileName = (metadata && metadata.fileName) || "download";

        elCompleteFileName.textContent = fileName;
        document.getElementById("complete-file-size").textContent = formatBytes(blob.size);
        showState(stateComplete);

        // Build preview
        var previewContainer = document.getElementById("preview-container");
        var largeFileThreshold = 100 * 1024 * 1024; // 100 MB
        var isLargeFile = blob.size > largeFileThreshold;

        if (!isLargeFile && mimeType.indexOf("image/") === 0) {
          var objectUrl = URL.createObjectURL(blob);
          var img = document.createElement("img");
          img.src = objectUrl;
          img.alt = fileName;
          previewContainer.appendChild(img);
        } else if (!isLargeFile && mimeType.indexOf("video/") === 0) {
          var objectUrl = URL.createObjectURL(blob);
          var video = document.createElement("video");
          video.src = objectUrl;
          video.controls = true;
          video.playsInline = true;
          previewContainer.appendChild(video);
        } else {
          var ext = fileName.indexOf(".") !== -1 ? fileName.split(".").pop().toUpperCase() : "FILE";
          previewContainer.innerHTML =
            '<div class="file-placeholder">' +
              '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">' +
                '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />' +
              '</svg>' +
              '<span class="file-type-label">' + ext + '</span>' +
            '</div>';
        }

        // Wire download button
        document.getElementById("download-btn").addEventListener("click", function () {
          triggerDownload(blob, fileName);
        });

        cleanup();
      }
    };

    channel.onerror = function () {
      if (awaitingAuth) return; // don't override password screen
      showError("Transfer failed. The sender may have gone offline.");
    };

    channel.onclose = function () {
      if (!stateComplete.classList.contains("hidden")) return;
      if (awaitingAuth) {
        // Channel closed during auth — show password error, not generic failure
        showState(statePassword);
        elPasswordError.textContent = "Too many failed attempts. Reload to try again.";
        elPasswordError.classList.remove("hidden");
        elPasswordSubmit.disabled = true;
        elPasswordInput.disabled = true;
        return;
      }
      if (metadata && receivedBytes < metadata.fileSize) {
        showError("Transfer failed. The sender may have gone offline.");
      }
    };
  }

  function handleAuth(channel) {
    waitForPassword().then(function (pw) {
      if (channel.readyState === "open") {
        channel.send(JSON.stringify({ type: "auth", password: pw }));
      }
    });
  }

  function promptForStreamingDownload(fileName, mimeType) {
    var types = [];
    if (fileName) {
      var ext = fileName.indexOf(".") !== -1 ? "." + fileName.split(".").pop() : "";
      if (ext) {
        var accept = {};
        accept[mimeType || "application/octet-stream"] = [ext];
        types.push({ description: "File", accept: accept });
      }
    }

    window.showSaveFilePicker({
      suggestedName: fileName || "download",
      types: types.length > 0 ? types : undefined,
    }).then(function (handle) {
      return handle.createWritable();
    }).then(function (writable) {
      fileWriter = writable;
      useStreaming = true;

      // Write any chunks already received in memory
      for (var i = 0; i < receivedChunks.length; i++) {
        fileWriter.write(new Uint8Array(receivedChunks[i])).catch(function () {});
      }
      // Free memory
      receivedChunks = [];
    }).catch(function () {
      // User cancelled picker or API failed — fall back to in-memory
      console.warn("[receiver] File System Access denied, falling back to in-memory download.");
      useStreaming = false;
    });
  }

  // ── ICE config fetch ───────────────────────────────────────────────

  function fetchIceConfig() {
    var httpUrl = RELAY_URL.replace(/^ws/, "http");
    return fetch(httpUrl + "/ice-config")
      .then(function (res) { return res.json(); })
      .then(function (config) {
        if (config.iceServers && config.iceServers.length > 0) {
          iceServers = config.iceServers;
        }
      })
      .catch(function () { /* use defaults */ });
  }

  // ── WebRTC ─────────────────────────────────────────────────────────

  function createPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: iceServers, iceCandidatePoolSize: 1 });

    pc.onicecandidate = function (event) {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "signal",
          shareId: shareId,
          sessionId: sessionId,
          data: { type: "ice-candidate", candidate: event.candidate }
        }));
      }
    };

    pc.ondatachannel = function (event) {
      setupDataChannel(event.channel);
    };

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        showError("Transfer failed. The sender may have gone offline.");
      }
    };
  }

  function handleSignalingData(data) {
    if (data.type === "offer") {
      createPeerConnection();

      pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(function () {
          return pc.createAnswer();
        })
        .then(function (answer) {
          return pc.setLocalDescription(answer).then(function () {
            return answer;
          });
        })
        .then(function (answer) {
          ws.send(JSON.stringify({
            type: "signal",
            shareId: shareId,
            sessionId: sessionId,
            data: { type: "answer", sdp: answer }
          }));
        })
        .catch(function (err) {
          console.error("[receiver] WebRTC handshake failed:", err);
          showError("Failed to establish connection.");
        });
    } else if (data.type === "ice-candidate" && pc) {
      pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function () {
        // Non-fatal: some candidates may fail
      });
    }
  }

  // ── HTTP direct download (LAN fast path) ─────────────────────────

  var httpDownloadAttempted = false;
  var httpDownloadSucceeded = false;

  function attemptHttpDownload(httpEndpoints, hasPassword) {
    if (httpDownloadAttempted) return;
    httpDownloadAttempted = true;

    // If password-protected, we need the password first
    var tokenPromise;
    if (hasPassword) {
      tokenPromise = waitForPassword().then(function (pw) {
        return sha256Hex(pw).then(function (hash) {
          return "?token=" + hash;
        });
      });
    } else {
      tokenPromise = Promise.resolve("");
    }

    tokenPromise.then(function (tokenQuery) {
      return tryHttpEndpoints(httpEndpoints, tokenQuery);
    }).catch(function (err) {
      // HTTP failed — WebRTC path continues normally
      console.warn("[receiver] HTTP download failed, using WebRTC fallback");
    });
  }

  function tryHttpEndpoints(endpoints, tokenQuery) {
    // Try each endpoint with a short timeout, race them
    var controllers = [];
    var promises = endpoints.map(function (base, idx) {
      var controller = new AbortController();
      controllers.push(controller);
      var url = base + "/download/" + encodeURIComponent(shareId) + tokenQuery;

      return fetchWithTimeout(url, controller, 3000).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return { res: res, base: base, index: idx };
      });
    });

    return promiseAny(promises).then(function (winner) {
      // Cancel other requests but NOT the winner
      controllers.forEach(function (c, i) {
        if (i !== winner.index) c.abort();
      });
      httpDownloadSucceeded = true;
      return handleHttpResponse(winner.res);
    }).catch(function () {
      // All endpoints failed — let WebRTC handle it
      controllers.forEach(function (c) { c.abort(); });
      return Promise.reject(new Error("all HTTP endpoints failed"));
    });
  }

  function fetchWithTimeout(url, controller, timeoutMs) {
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal }).then(function (res) {
      clearTimeout(timer);
      return res;
    }).catch(function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function handleHttpResponse(res) {
    var fileName = "download";
    var fileSize = 0;
    var mimeType = res.headers.get("Content-Type") || "application/octet-stream";

    // Parse Content-Disposition for filename
    var disposition = res.headers.get("Content-Disposition") || "";
    var fnMatch = disposition.match(/filename="?([^";\n]+)"?/);
    if (fnMatch) fileName = decodeURIComponent(fnMatch[1]);

    var cl = res.headers.get("Content-Length");
    if (cl) fileSize = parseInt(cl, 10);

    metadata = { fileName: fileName, fileSize: fileSize, mimeType: mimeType };
    elFileName.textContent = fileName;
    elFileSize.textContent = formatBytes(fileSize);
    showState(stateDownloading);

    speedStartTime = Date.now();
    speedStartBytes = 0;
    speedInterval = setInterval(updateSpeed, 1000);

    // Stream the response body
    var reader = res.body.getReader();

    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          // Transfer complete
          if (speedInterval) clearInterval(speedInterval);
          finishDownload();
          return;
        }

        var chunk = result.value;
        receivedBytes += chunk.byteLength;

        if (useStreaming && fileWriter) {
          fileWriter.write(chunk).catch(function () {});
        } else {
          receivedChunks.push(chunk.buffer);
        }

        updateProgress();
        return pump();
      });
    }

    // Decide streaming vs in-memory (same logic as WebRTC path)
    if (supportsFileSystemAccess && fileSize > 100 * 1024 * 1024) {
      promptForStreamingDownload(fileName, mimeType);
    } else if (!supportsFileSystemAccess) {
      if (fileSize > 4 * 1024 * 1024 * 1024) {
        showError("File is too large for this browser (>4GB). Use Chrome or Edge for large file support.");
        return;
      }
      if (fileSize > 2 * 1024 * 1024 * 1024) {
        console.warn("[receiver] File >2GB — may run out of memory in this browser.");
      }
    }

    return pump();
  }

  function finishDownload() {
    if (useStreaming && fileWriter) {
      fileWriter.close().then(function () {
        fileWriter = null;
        var fileName = (metadata && metadata.fileName) || "download";
        elCompleteFileName.textContent = fileName;
        document.getElementById("complete-file-size").textContent = formatBytes(receivedBytes);
        showState(stateComplete);
        var previewContainer = document.getElementById("preview-container");
        previewContainer.innerHTML =
          '<div class="file-placeholder">' +
            '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">' +
              '<path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />' +
            '</svg>' +
            '<span class="file-type-label">Saved to disk</span>' +
          '</div>';
        document.getElementById("download-btn").style.display = "none";
        cleanup();
      });
      return;
    }

    // In-memory download
    var mimeType = (metadata && metadata.mimeType) || "application/octet-stream";
    var blob = new Blob(receivedChunks, { type: mimeType });
    var fileName = (metadata && metadata.fileName) || "download";

    elCompleteFileName.textContent = fileName;
    document.getElementById("complete-file-size").textContent = formatBytes(blob.size);
    showState(stateComplete);

    // Build preview
    var previewContainer = document.getElementById("preview-container");
    var largeFileThreshold = 100 * 1024 * 1024;
    var isLargeFile = blob.size > largeFileThreshold;

    if (!isLargeFile && mimeType.indexOf("image/") === 0) {
      var objectUrl = URL.createObjectURL(blob);
      var img = document.createElement("img");
      img.src = objectUrl;
      img.alt = fileName;
      previewContainer.appendChild(img);
    } else if (!isLargeFile && mimeType.indexOf("video/") === 0) {
      var objectUrl = URL.createObjectURL(blob);
      var video = document.createElement("video");
      video.src = objectUrl;
      video.controls = true;
      video.playsInline = true;
      previewContainer.appendChild(video);
    } else {
      var ext = fileName.indexOf(".") !== -1 ? fileName.split(".").pop().toUpperCase() : "FILE";
      previewContainer.innerHTML =
        '<div class="file-placeholder">' +
          '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">' +
            '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />' +
          '</svg>' +
          '<span class="file-type-label">' + ext + '</span>' +
        '</div>';
    }

    // Wire download button
    document.getElementById("download-btn").addEventListener("click", function () {
      triggerDownload(blob, fileName);
    });

    cleanup();
  }

  function sha256Hex(str) {
    var encoder = new TextEncoder();
    var data = encoder.encode(str);
    return crypto.subtle.digest("SHA-256", data).then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      var hex = "";
      for (var i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, "0");
      }
      return hex;
    });
  }

  // Promise.any polyfill for older browsers
  function promiseAny(promises) {
    if (typeof Promise.any === "function") return Promise.any(promises);
    return new Promise(function (resolve, reject) {
      var errors = [];
      var remaining = promises.length;
      if (remaining === 0) return reject(new Error("empty"));
      promises.forEach(function (p, i) {
        Promise.resolve(p).then(resolve).catch(function (err) {
          errors[i] = err;
          remaining--;
          if (remaining === 0) reject(new Error("all failed"));
        });
      });
    });
  }

  function handleRelayMessage(msg) {
    if (msg.type === "file-info") {
      // Show file name + size immediately
      if (msg.fileName) {
        elFileName.textContent = msg.fileName;
        elFileSize.textContent = formatBytes(msg.fileSize || 0);
        showState(stateDownloading);
      }
      // Try HTTP direct download if endpoints available
      if (msg.httpEndpoints && msg.httpEndpoints.length > 0) {
        attemptHttpDownload(msg.httpEndpoints, msg.hasPassword);
      }
    } else if (msg.type === "signal") {
      // If HTTP already succeeded, ignore WebRTC signaling
      if (httpDownloadSucceeded) return;
      handleSignalingData(msg.data);
    } else if (msg.type === "error") {
      if (msg.message === "shareId not found") {
        showState(stateNotFound);
        cleanup();
      } else {
        showError(msg.message || "An unexpected error occurred.");
      }
    }
  }

  // ── Connect to relay ───────────────────────────────────────────────

  showState(stateConnecting);

  // Fetch TURN config first, then connect
  fetchIceConfig().then(function () {
    try {
      ws = new WebSocket(RELAY_URL);
    } catch (_) {
      showError("Could not connect to relay server.");
      return;
    }

    ws.onopen = function () {
      console.log("[receiver] connected");
      ws.send(JSON.stringify({
        type: "request",
        shareId: shareId,
        sessionId: sessionId
      }));
    };

    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      handleRelayMessage(msg);
    };

    ws.onerror = function (err) {
      console.error("[receiver] WebSocket error:", err);
      showError("Could not connect to relay server.");
    };

    ws.onclose = function () {
      if (!stateConnecting.classList.contains("hidden")) {
        showError("Could not connect to relay server.");
      }
    };
  });
})();
