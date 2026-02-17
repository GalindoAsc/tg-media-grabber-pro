/**
 * TG Media Grabber Pro — Page Context Injected Script
 * This runs in the MAIN WORLD (page context) to intercept
 * Telegram's internal fetch/XHR calls and capture real media URLs.
 *
 * Communicates back to content script via window.postMessage.
 */
(function () {
  "use strict";

  const CAPTURED = new Map(); // url -> { blobs[], totalSize, mime, fileName }

  // Intercept fetch() to capture video/audio streaming responses
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const request = args[0];
    const url = typeof request === "string" ? request : request?.url;

    return origFetch.apply(this, args).then((response) => {
      try {
        const ct = response.headers.get("Content-Type") || "";
        const cr = response.headers.get("Content-Range") || "";

        // Only intercept video/audio streams
        if (ct.startsWith("video/") || ct.startsWith("audio/")) {
          const clonedResp = response.clone();

          clonedResp.blob().then((blob) => {
            let totalSize = null;
            const rangeMatch = cr.match(/bytes (\d+)-(\d+)\/(\d+)/);
            if (rangeMatch) {
              totalSize = parseInt(rangeMatch[3]);
            }

            // Extract fileName from stream URL if possible
            let fileName = null;
            try {
              const parts = (url || "").split("/");
              const last = decodeURIComponent(parts[parts.length - 1]);
              const meta = JSON.parse(last);
              if (meta.fileName) fileName = meta.fileName;
            } catch (_) {}

            const key = url?.split("?")[0] || url;

            if (!CAPTURED.has(key)) {
              CAPTURED.set(key, { blobs: [], totalSize, mime: ct.split(";")[0], fileName, received: 0 });
            }

            const entry = CAPTURED.get(key);
            entry.blobs.push(blob);
            entry.received += blob.size;
            if (totalSize) entry.totalSize = totalSize;

            // When complete, notify content script
            if (entry.totalSize && entry.received >= entry.totalSize) {
              const finalBlob = new Blob(entry.blobs, { type: entry.mime });
              const blobUrl = URL.createObjectURL(finalBlob);
              window.postMessage({
                type: "TG_GRABBER_MEDIA_READY",
                url: key,
                blobUrl,
                mime: entry.mime,
                size: finalBlob.size,
                fileName: entry.fileName,
              }, "*");
              CAPTURED.delete(key);
            }

            // Also always post partial progress
            window.postMessage({
              type: "TG_GRABBER_MEDIA_CHUNK",
              url: key,
              mime: entry.mime,
              received: entry.received,
              total: entry.totalSize,
              fileName: entry.fileName,
            }, "*");
          }).catch(() => {});
        }
      } catch (_) {}

      return response;
    });
  };

  // Also intercept XMLHttpRequest for older patterns
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._tgGrabUrl = url;
    return origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const ct = this.getResponseHeader("Content-Type") || "";
        if ((ct.startsWith("video/") || ct.startsWith("audio/")) && this.response) {
          const blob = this.response instanceof Blob ? this.response : new Blob([this.response]);
          const blobUrl = URL.createObjectURL(blob);
          const key = this._tgGrabUrl?.split("?")[0] || this._tgGrabUrl;

          let fileName = null;
          try {
            const parts = (this._tgGrabUrl || "").split("/");
            const last = decodeURIComponent(parts[parts.length - 1]);
            const meta = JSON.parse(last);
            if (meta.fileName) fileName = meta.fileName;
          } catch (_) {}

          window.postMessage({
            type: "TG_GRABBER_MEDIA_READY",
            url: key,
            blobUrl,
            mime: ct.split(";")[0],
            size: blob.size,
            fileName,
          }, "*");
        }
      } catch (_) {}
    });
    return origXHRSend.apply(this, args);
  };

  // Provide a way for content script to trigger download of a specific video
  // by clicking play and waiting for chunks to come through
  window._tgGrabberRequestDownload = (videoEl) => {
    if (!videoEl) return;
    // Force load the video by playing it briefly
    const wasPaused = videoEl.paused;
    const wasTime = videoEl.currentTime;
    videoEl.currentTime = 0;
    videoEl.play().catch(() => {});

    // It will be captured by fetch interceptor above
    // Return to previous state after a small delay
    setTimeout(() => {
      if (wasPaused) videoEl.pause();
      videoEl.currentTime = wasTime;
    }, 500);
  };

  console.log("[TG Grabber] Interceptor de red inyectado ✓");
})();
