/**
 * TG Media Grabber Pro — Page Context Injected Script
 * Runs in MAIN WORLD to access Telegram's Service Worker.
 *
 * KEY INSIGHT: Telegram K and A use a Service Worker that intercepts
 * fetch requests to /stream/ and /progressive/ URLs. These URLs return
 * 404 when fetched from a content script (different context), but work
 * perfectly when fetched from the PAGE context because the SW only
 * intercepts same-origin page fetches.
 *
 * This script receives download requests from the content script via
 * postMessage, fetches through the SW, and returns blob URLs back.
 */
(function () {
  "use strict";

  const LOG = "[TG Grabber]";

  /**
   * Parse stream URL to extract file metadata
   * K: /k/stream/{"dcId":1,"location":{...},"size":N,"mimeType":"video/mp4","fileName":"xxx.mp4"}
   * A: /a/progressive/document{id}
   */
  function parseStreamUrl(url) {
    try {
      const decoded = decodeURIComponent(url);

      // Telegram K
      const streamIdx = decoded.indexOf("/stream/");
      if (streamIdx !== -1) {
        const json = decoded.substring(streamIdx + 8);
        const meta = JSON.parse(json);
        return {
          fileName: meta.fileName || null,
          size: meta.size || null,
          mimeType: meta.mimeType || null,
        };
      }

      // Telegram A
      const progIdx = decoded.indexOf("/progressive/");
      if (progIdx !== -1) {
        return { fileName: null, size: null, mimeType: null };
      }
    } catch (_) {}
    return null;
  }

  /**
   * Download a file through Telegram's Service Worker.
   * Uses Range requests in chunks for reliability.
   */
  async function downloadViaSW(streamUrl, onProgress) {
    const meta = parseStreamUrl(streamUrl);
    const fileName = meta?.fileName || "video.mp4";
    const mimeType = meta?.mimeType || "video/mp4";
    let totalSize = meta?.size || null;

    console.log(`${LOG} SW Download: ${fileName} (${totalSize ? (totalSize / 1048576).toFixed(1) + " MB" : "?"})`);

    // If we don't know the size, try HEAD or a full GET first
    if (!totalSize) {
      try {
        const probe = await fetch(streamUrl, { headers: { Range: "bytes=0-0" } });
        const cr = probe.headers.get("Content-Range");
        if (cr) {
          const m = cr.match(/\/(\d+)/);
          if (m) totalSize = parseInt(m[1]);
        }
        if (!totalSize) {
          const cl = probe.headers.get("Content-Length");
          if (cl) totalSize = parseInt(cl);
        }
      } catch (_) {}
    }

    // Strategy A: If we know the size, download in 512KB chunks
    if (totalSize && totalSize > 0) {
      const CHUNK = 512 * 1024; // 512KB
      const blobs = [];
      let offset = 0;
      let failures = 0;

      while (offset < totalSize) {
        const end = Math.min(offset + CHUNK - 1, totalSize - 1);

        try {
          const resp = await fetch(streamUrl, {
            headers: { Range: `bytes=${offset}-${end}` },
          });

          if (!resp.ok && resp.status !== 206) {
            failures++;
            if (failures > 3) throw new Error(`HTTP ${resp.status} after retries`);
            await new Promise((r) => setTimeout(r, 300 * failures));
            continue; // retry same chunk
          }

          const blob = await resp.blob();
          blobs.push(blob);
          offset = end + 1;
          failures = 0;

          if (onProgress) {
            onProgress(Math.round((offset / totalSize) * 100), offset, totalSize);
          }
        } catch (e) {
          failures++;
          if (failures > 3) throw e;
          await new Promise((r) => setTimeout(r, 300 * failures));
        }
      }

      const finalBlob = new Blob(blobs, { type: mimeType });
      console.log(`${LOG} ✓ ${fileName} (${(finalBlob.size / 1048576).toFixed(1)} MB)`);
      return {
        blobUrl: URL.createObjectURL(finalBlob),
        size: finalBlob.size,
        fileName,
        mimeType,
      };
    }

    // Strategy B: No size known - single full fetch
    const resp = await fetch(streamUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (blob.size < 100) throw new Error("Empty response");

    console.log(`${LOG} ✓ ${fileName} (${(blob.size / 1048576).toFixed(1)} MB)`);
    return {
      blobUrl: URL.createObjectURL(blob),
      size: blob.size,
      fileName,
      mimeType: blob.type || mimeType,
    };
  }

  /**
   * Listen for download requests from content script
   */
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;

    if (event.data?.type === "TG_GRABBER_DOWNLOAD_REQUEST") {
      const { streamUrl, requestId } = event.data;

      try {
        const result = await downloadViaSW(streamUrl, (pct, received, total) => {
          window.postMessage({
            type: "TG_GRABBER_DOWNLOAD_PROGRESS",
            requestId, pct, received, total,
          }, "*");
        });

        window.postMessage({
          type: "TG_GRABBER_DOWNLOAD_COMPLETE",
          requestId,
          blobUrl: result.blobUrl,
          size: result.size,
          fileName: result.fileName,
          mimeType: result.mimeType,
        }, "*");
      } catch (e) {
        console.error(`${LOG} Download error:`, e);
        window.postMessage({
          type: "TG_GRABBER_DOWNLOAD_ERROR",
          requestId,
          error: e.message,
        }, "*");
      }
    }
  });

  console.log(`${LOG} Interceptor v2.2 listo ✓`);
})();
