/**
 * TG Media Grabber Pro v2 — Content Script
 * Full support for web.telegram.org/k/ AND /a/
 * Features: individual DL, bulk DL, auto-scroll, gallery preview,
 *           restricted content bypass, media viewer DL, stories DL,
 *           keyboard shortcuts, drag-select
 */
(function () {
  "use strict";

  // =============================================
  // CONSTANTS & STATE
  // =============================================
  const LOG = "[TG Grabber]";
  const log = {
    i: (m) => console.log(`${LOG} ${m}`),
    w: (m) => console.warn(`${LOG} ${m}`),
    e: (m) => console.error(`${LOG} ${m}`),
  };

  const DOWNLOAD_ICON_UNI = "\ue977"; // K app icon font codepoint
  const FORWARD_ICON_UNI = "\ue995";
  const RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

  const S = {
    isK: location.pathname.startsWith("/k") || location.host.startsWith("webk"),
    isA: location.pathname.startsWith("/a") || location.host.startsWith("webz"),
    buttonsEnabled: true,
    restrictedEnabled: true,
    folderName: "TG_Media",
    downloading: false,
    observerActive: false,
    galleryOpen: false,
    scannedMedia: [],
    downloadHistory: [],
    abortController: null,
    capturedMedia: new Map(), // URL -> { blobUrl, mime, size, fileName }
    pendingDownloads: new Map(), // URL -> { resolve, reject, fileName }
  };

  // =============================================
  // SVG ICONS
  // =============================================
  const ICO = {
    dl: `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`,
    ok: `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
    spin: `<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`,
  };

  // =============================================
  // HELPERS
  // =============================================
  const hashStr = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  const extFromMime = (m) => {
    const map = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3" };
    return map[m] || (m ? m.split("/")[1] : "bin") || "bin";
  };

  const humanSize = (b) => {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  };

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Try to extract original filename from Telegram's stream URL or element
  function extractFileName(src, element, type) {
    // Method 1: Parse from stream URL metadata JSON
    if (src) {
      try {
        const parts = src.split("/");
        const last = decodeURIComponent(parts[parts.length - 1]);
        const meta = JSON.parse(last);
        if (meta.fileName) return meta.fileName;
      } catch (_) {}
    }

    // Method 2: From document name element (K)
    if (element) {
      const nameEl = element.closest?.(".bubble, .Message")?.querySelector(
        ".document-name, .text-bold, .File .content .title, .document-attribute-file-name"
      );
      if (nameEl?.textContent?.trim()) return nameEl.textContent.trim();
    }

    // Method 3: From download attribute on existing links
    if (element) {
      const link = element.closest?.(".bubble, .Message")?.querySelector("a[download]");
      if (link?.download) return link.download;
    }

    // Method 4: Generate a name preserving the original hash for traceability
    const hash = src ? hashStr(src) : ((Math.random() + 1).toString(36).substring(2, 8));
    const extMap = { photo: "jpg", video: "mp4", gif: "mp4", audio: "ogg", doc: "bin" };
    return `${hash}.${extMap[type] || "bin"}`;
  }

  // =============================================
  // DOWNLOAD ENGINE
  // =============================================
  async function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const doFallback = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: "download",
          url,
          fileName: `${S.folderName}/${fileName}`,
        }, (response) => {
          if (chrome.runtime.lastError || !response) {
            doFallback();
          }
        });
      } else {
        doFallback();
      }
    } catch (_) {
      doFallback();
    }
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    log.i(`✓ ${fileName}`);
  }

  async function downloadUrl(url, fileName) {
    try {
      const blob = await (await fetch(url)).blob();
      const ext = extFromMime(blob.type);
      // Fix extension if we got a generic name
      if (fileName.endsWith(".bin") || fileName.endsWith(".undefined")) {
        fileName = fileName.replace(/\.[^.]+$/, `.${ext}`);
      }
      await downloadBlob(blob, fileName);
      return true;
    } catch (e) {
      log.e(`Fetch error: ${e.message}`);
      return false;
    }
  }

  // Chunked video download with progress (like the Neet-Nestor approach)
  async function downloadVideoChunked(url, fileName, onProgress) {
    let blobs = [];
    let offset = 0;
    let total = null;

    while (true) {
      if (S.abortController?.signal.aborted) throw new Error("Aborted");

      const res = await fetch(url, {
        method: "GET",
        headers: { Range: `bytes=${offset}-` },
        signal: S.abortController?.signal,
      });

      if (![200, 206].includes(res.status)) throw new Error(`HTTP ${res.status}`);

      const mime = res.headers.get("Content-Type")?.split(";")[0] || "video/mp4";
      const rangeHeader = res.headers.get("Content-Range");

      if (rangeHeader) {
        const m = rangeHeader.match(RANGE_RE);
        if (m) {
          offset = parseInt(m[2]) + 1;
          total = parseInt(m[3]);
        }
      }

      const blob = await res.blob();
      blobs.push(blob);

      if (total && onProgress) {
        onProgress(Math.min(100, Math.round((offset / total) * 100)));
      }

      // If full response (200) or we've got everything
      if (res.status === 200 || !total || offset >= total) break;
    }

    const finalBlob = new Blob(blobs, { type: "video/mp4" });
    // Fix extension from actual MIME
    const ext = extFromMime(finalBlob.type);
    if (!fileName.match(/\.(mp4|webm|mkv|mov|avi)$/i)) {
      fileName = fileName.replace(/\.[^.]+$/, `.${ext}`);
    }
    await downloadBlob(finalBlob, fileName);
    return true;
  }

  // =============================================
  // MEDIA DETECTION — DUAL ENGINE (K + A)
  // =============================================
  function detectVersion() {
    // Check URL first (most reliable)
    const path = location.pathname;
    const host = location.host;
    if (path.startsWith("/a") || host.startsWith("webz")) return "A";
    if (path.startsWith("/k") || host.startsWith("webk")) return "K";
    // Then check DOM
    if (document.querySelector("#MiddleColumn, .MessageList, #MediaViewer")) return "A";
    if (document.querySelector(".bubbles-inner, #column-center, .media-viewer-whole")) return "K";
    return "K"; // default
  }

  /** Selectors for each version */
  const SEL = {
    K: {
      chatContainer: ".bubbles-inner, #column-center .bubbles",
      message: ".bubble",
      mediaViewer: ".media-viewer-whole",
      mediaViewerMedia: ".media-viewer-movers .media-viewer-aspecter",
      mediaViewerButtons: ".media-viewer-topbar .media-viewer-buttons",
      mediaViewerVideo: ".ckin__player video, video",
      mediaViewerImg: "img.thumbnail",
      stories: "#stories-viewer",
      storyVideo: "video.media-video",
      storyImg: "img.media-photo",
    },
    A: {
      chatContainer: ".MessageList, .messages-container, #MiddleColumn, #middle-column-portals",
      message: ".Message, .message, [class*='Message ']",
      mediaViewer: "#MediaViewer, [class*='MediaViewer']",
      mediaViewerMedia: ".MediaViewerSlide--active .MediaViewerContent, [class*='MediaViewerSlide'] [class*='MediaViewerContent']",
      mediaViewerButtons: ".MediaViewerActions, [class*='MediaViewerActions']",
      mediaViewerVideo: ".VideoPlayer video, [class*='VideoPlayer'] video, video",
      mediaViewerImg: "img.full-media, img[class*='full-media'], .MediaViewerContent > div > img, img:not(.emoji):not(.sticker-media):not([class*='avatar'])",
      stories: "#StoryViewer, [class*='StoryViewer']",
      storyVideo: "video",
      storyImg: "img[class*='full-media'], img:not(.emoji)",
    },
  };

  function findMediaInMessage(msg, version) {
    const media = [];
    const v = version || detectVersion();

    // — PHOTOS —
    // K: img inside .media-photo, .media-container, .attachment (exclude avatars, emoji, stickers)
    // A: img inside .Photo, .media-inner, .thumbnail
    const imgSels = v === "K"
      ? "img.media-photo, .media-photo img, .media-container img, .attachment img"
      : ".Photo img, .media-inner img, img.full-media, img.thumbnail, [class*='Photo'] img, img[class*='full-media']";

    msg.querySelectorAll(imgSels).forEach((img) => {
      const src = img.src || img.dataset?.src;
      if (!src) return;
      if (/avatar|emoji|sticker|profile/i.test(src)) return;
      if (img.width < 40 && img.height < 40) return;
      media.push({ type: "photo", el: img, src, thumb: src, name: extractFileName(src, img, "photo") });
    });

    // K: canvas-rendered photos
    if (v === "K") {
      msg.querySelectorAll("canvas").forEach((c) => {
        if (c.closest(".media-photo, .media-container")) {
          media.push({ type: "photo", el: c, src: null, thumb: null, name: extractFileName(null, c, "photo"), isCanvas: true });
        }
      });
    }

    // — VIDEOS —
    const videoSels = v === "K"
      ? "video:not(.media-round video):not([loop])"
      : ".VideoPlayer video, video.full-media, [class*='VideoPlayer'] video, video:not([loop])";
    msg.querySelectorAll(videoSels).forEach((vid) => {
      const src = vid.src || vid.currentSrc || vid.querySelector("source")?.src;
      if (!src) return;
      // Poster as thumbnail
      const thumb = vid.poster || null;
      media.push({ type: "video", el: vid, src, thumb, name: extractFileName(src, vid, "video") });
    });

    // — GIFs (looped video) —
    const gifSels = v === "K"
      ? ".media-gif video, .media-round video, video[loop]"
      : "video[loop], .gif-video";
    msg.querySelectorAll(gifSels).forEach((g) => {
      if (media.some((m) => m.el === g)) return; // skip duplicates
      const src = g.src || g.currentSrc;
      if (!src) return;
      media.push({ type: "gif", el: g, src, thumb: g.poster || null, name: extractFileName(src, g, "gif") });
    });

    // — AUDIO / VOICE —
    if (v === "K") {
      msg.querySelectorAll("audio-element, audio").forEach((a) => {
        const audioEl = a.audio || a;
        const src = audioEl?.src || audioEl?.querySelector?.("source")?.src;
        if (src) {
          media.push({ type: "audio", el: a, src, thumb: null, name: extractFileName(src, a, "audio") });
        }
      });
    } else {
      msg.querySelectorAll(".Audio audio, audio").forEach((a) => {
        const src = a.src || a.querySelector("source")?.src;
        if (src) media.push({ type: "audio", el: a, src, thumb: null, name: extractFileName(src, a, "audio") });
      });
    }

    // — DOCUMENTS —
    const docSels = v === "K"
      ? ".document-container, .document"
      : ".Document, .File";
    msg.querySelectorAll(docSels).forEach((d) => {
      // Don't double-count audio
      if (d.querySelector("audio, audio-element")) return;
      const nameEl = d.querySelector(".document-name, .text-bold, .title, .file-name");
      const name = nameEl?.textContent?.trim() || "document";
      media.push({ type: "doc", el: d, src: null, thumb: null, name });
    });

    return media;
  }

  // =============================================
  // INJECT PAGE-CONTEXT INTERCEPTOR
  // =============================================
  function injectInterceptor() {
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("js/injected.js");
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
      log.i("Interceptor de red inyectado");
    } catch (e) {
      log.w("No se pudo inyectar interceptor: " + e.message);
    }
  }

  // =============================================
  // DOWNLOAD A SINGLE MEDIA ITEM
  // =============================================

  let _dlRequestId = 0;
  const _dlPendingRequests = new Map(); // requestId -> { resolve, reject }

  /**
   * Listen for responses from injected.js
   */
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const { type, requestId } = event.data || {};

    if (type === "TG_GRABBER_DOWNLOAD_COMPLETE" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.resolve(event.data);
    }

    if (type === "TG_GRABBER_DOWNLOAD_ERROR" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.reject(new Error(event.data.error));
    }

    if (type === "TG_GRABBER_DOWNLOAD_PROGRESS") {
      const { pct, received, total } = event.data;
      if (pct % 20 === 0) {
        log.i(`Descargando: ${pct}% (${humanSize(received)}/${humanSize(total)})`);
      }
    }
  });

  /**
   * Download a video/audio by sending the stream URL to injected.js,
   * which fetches through Telegram's Service Worker in page context.
   */
  function downloadViaInjected(streamUrl, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const requestId = ++_dlRequestId;
      const timer = setTimeout(() => {
        _dlPendingRequests.delete(requestId);
        reject(new Error("SW download timeout"));
      }, timeoutMs);

      _dlPendingRequests.set(requestId, {
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      window.postMessage({
        type: "TG_GRABBER_DOWNLOAD_REQUEST",
        streamUrl,
        requestId,
      }, "*");
    });
  }

  /**
   * Extract stream URL from a video element.
   * Telegram K: <video src="/k/stream/{json}"> — parseable
   * Telegram A: <video src="blob:..."> — need different approach
   */
  function getStreamUrl(videoEl) {
    const src = videoEl?.src || videoEl?.currentSrc || "";

    // Non-blob URL = stream URL (K version usually)
    if (src && !src.startsWith("blob:")) return src;

    // Check <source> elements
    const source = videoEl?.querySelector?.("source");
    if (source?.src && !source.src.startsWith("blob:")) return source.src;

    return src; // Return blob: as fallback
  }

  /**
   * Extract fileName from stream URL metadata
   */
  function fileNameFromStreamUrl(url) {
    try {
      const decoded = decodeURIComponent(url);
      const idx = decoded.indexOf("/stream/");
      if (idx !== -1) {
        const meta = JSON.parse(decoded.substring(idx + 8));
        if (meta.fileName) return meta.fileName;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Smart video download with multiple strategies
   */
  async function downloadVideoSmart(videoEl, fileName, onProgress) {
    if (!videoEl) { log.w("Video element null"); return false; }

    const streamUrl = getStreamUrl(videoEl);
    log.i(`Video: ${streamUrl.substring(0, 100)}...`);

    // Get real filename from stream URL if possible
    const realName = fileNameFromStreamUrl(streamUrl) || fileName;

    // Strategy 1: Non-blob URL → send to injected.js for SW download
    if (streamUrl && !streamUrl.startsWith("blob:")) {
      try {
        log.i(`Descargando via Service Worker: ${realName}`);
        const result = await downloadViaInjected(streamUrl);
        if (result?.blobUrl) {
          const finalName = result.fileName || realName;
          log.i(`SW completó: ${finalName} (${humanSize(result.size)})`);
          await downloadBlob(await (await fetch(result.blobUrl)).blob(), finalName);
          URL.revokeObjectURL(result.blobUrl);
          return true;
        }
      } catch (e) {
        log.w(`SW download failed: ${e.message}`);
      }
    }

    // Strategy 2: Blob URL → fetch directly (works for images, small videos)
    if (streamUrl?.startsWith("blob:")) {
      try {
        const resp = await fetch(streamUrl);
        const blob = await resp.blob();
        if (blob.size > 50000) { // > 50KB seems complete
          log.i(`Blob directo: ${realName} (${humanSize(blob.size)})`);
          const ext = extFromMime(blob.type);
          const fixedName = realName.match(/\.(mp4|webm|mkv|mov|avi|ogg|mp3)$/i)
            ? realName : realName.replace(/\.[^.]+$/, `.${ext}`);
          await downloadBlob(blob, fixedName);
          return true;
        }
        log.w(`Blob muy pequeño: ${humanSize(blob.size)}, intentando MediaRecorder...`);
      } catch (e) {
        log.w(`Blob fetch failed: ${e.message}`);
      }
    }

    // Strategy 3: MediaRecorder as last resort
    try {
      log.i("Usando MediaRecorder...");
      const stream = videoEl.captureStream ? videoEl.captureStream() : videoEl.mozCaptureStream?.();
      if (!stream) throw new Error("captureStream no disponible");

      const chunks = [];
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : MediaRecorder.isTypeSupported("video/webm")
          ? "video/webm" : "video/mp4";

      return new Promise((resolve) => {
        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = async () => {
          const blob = new Blob(chunks, { type: mimeType });
          const ext = mimeType.includes("webm") ? "webm" : "mp4";
          const fixedName = realName.replace(/\.[^.]+$/, `.${ext}`);
          log.i(`MediaRecorder: ${fixedName} (${humanSize(blob.size)})`);
          await downloadBlob(blob, fixedName);
          resolve(true);
        };
        recorder.onerror = () => resolve(false);

        const wasPaused = videoEl.paused;
        const oldTime = videoEl.currentTime;
        videoEl.currentTime = 0;
        recorder.start(100); // collect data every 100ms

        videoEl.addEventListener("ended", function onEnd() {
          videoEl.removeEventListener("ended", onEnd);
          recorder.stop();
          if (wasPaused) videoEl.pause();
          videoEl.currentTime = oldTime;
        });

        // Safety timeout
        setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 600000);
        if (videoEl.paused) videoEl.play().catch(() => {});
      });
    } catch (e) {
      log.e(`MediaRecorder failed: ${e.message}`);
    }

    // Strategy 4: download whatever blob we can get
    if (streamUrl) {
      try {
        await downloadUrl(streamUrl, realName);
        return true;
      } catch (_) {}
    }

    log.e(`No se pudo descargar: ${realName}`);
    return false;
  }

  async function downloadItem(item, onProgress) {
    const { type, src, el, name, isCanvas } = item;

    if (type === "photo" && isCanvas) {
      return new Promise((res) => {
        el.toBlob((b) => { if (b) downloadBlob(b, name.replace(/\.[^.]+$/, ".png")); res(true); }, "image/png");
      });
    }
    if (type === "photo") {
      if (src) return downloadUrl(src, name);
    }
    if (type === "gif" || type === "video") {
      if (el?.tagName === "VIDEO") {
        return downloadVideoSmart(el, name, onProgress);
      }
      // src might be a stream URL even without a video element
      if (src && !src.startsWith("blob:")) {
        const realName = fileNameFromStreamUrl(src) || name;
        try {
          const result = await downloadViaInjected(src);
          if (result?.blobUrl) {
            await downloadBlob(await (await fetch(result.blobUrl)).blob(), result.fileName || realName);
            URL.revokeObjectURL(result.blobUrl);
            return true;
          }
        } catch (_) {}
      }
      if (src) return downloadUrl(src, name);
    }
    if (type === "audio") {
      // Audio may also use stream URLs
      if (src && !src.startsWith("blob:")) {
        const realName = fileNameFromStreamUrl(src) || name;
        try {
          const result = await downloadViaInjected(src);
          if (result?.blobUrl) {
            await downloadBlob(await (await fetch(result.blobUrl)).blob(), result.fileName || realName);
            URL.revokeObjectURL(result.blobUrl);
            return true;
          }
        } catch (_) {}
        return downloadUrl(src, name);
      }
      if (src) return downloadUrl(src, name);
    }
    if (type === "doc") {
      const dlBtn = el.querySelector?.('button[class*="download"], .download, [data-type="download"]');
      if (dlBtn) { dlBtn.click(); return true; }
      log.w(`Doc sin botón: ${name}`);
      return false;
    }
    return false;
  }

  // =============================================
  // BUTTON INJECTION
  // =============================================
  function makeBtn(pos = "top-right") {
    const b = document.createElement("button");
    b.className = "tg-grab-btn";
    b.innerHTML = ICO.dl;
    b.title = "Descargar";
    if (pos === "top-left") { b.style.right = "auto"; b.style.left = "6px"; }
    if (pos === "bottom-right") { b.style.top = "auto"; b.style.bottom = "6px"; }
    return b;
  }

  function injectButtons() {
    if (!S.buttonsEnabled) return;
    const v = detectVersion();
    const msgs = document.querySelectorAll(SEL[v].message);

    msgs.forEach((msg) => {
      if (msg.dataset.tgGrab === "1") return;
      msg.dataset.tgGrab = "1";

      const items = findMediaInMessage(msg, v);
      if (!items.length) return;

      items.forEach((item) => {
        const container = item.el.closest?.(
          v === "K"
            ? ".media-container, .media-inner, .media-photo, .attachment, .document-container, .bubble"
            : ".Photo, .Video, .media-inner, .Document, .Audio, .File, .Message"
        ) || msg;

        if (getComputedStyle(container).position === "static") {
          container.style.position = "relative";
        }

        const btn = makeBtn();
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (btn.classList.contains("downloading")) return;

          btn.classList.add("downloading");
          btn.innerHTML = ICO.spin;

          try {
            await downloadItem(item);
            btn.classList.remove("downloading");
            btn.classList.add("done");
            btn.innerHTML = ICO.ok;
            setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = ICO.dl; }, 2500);
          } catch (err) {
            log.e(err.message);
            btn.classList.remove("downloading");
            btn.innerHTML = ICO.dl;
          }
        });

        container.appendChild(btn);
      });
    });
  }

  // =============================================
  // MEDIA VIEWER HANDLER
  // =============================================
  function watchMediaViewer() {
    const v = detectVersion();

    const observer = new MutationObserver(() => {
      const viewer = document.querySelector(SEL[v].mediaViewer);
      if (!viewer || viewer.querySelector(".tg-grab-viewer-btn")) return;

      // --- K version: also unhide restricted buttons ---
      if (v === "K") {
        const btns = viewer.querySelectorAll(".media-viewer-buttons button.btn-icon.hide");
        btns.forEach((b) => {
          b.classList.remove("hide");
          if (b.textContent === FORWARD_ICON_UNI) b.classList.add("tgico-forward");
          if (b.textContent === DOWNLOAD_ICON_UNI) b.classList.add("tgico-download");
        });
      }

      const mediaArea = viewer.querySelector(SEL[v].mediaViewerMedia);
      if (!mediaArea) return;

      const video = mediaArea.querySelector(SEL[v].mediaViewerVideo);
      const img = mediaArea.querySelector(SEL[v].mediaViewerImg);

      if (!video && !img) return;

      const dlBtn = document.createElement("button");
      dlBtn.className = "tg-grab-viewer-btn";
      dlBtn.innerHTML = `${ICO.dl} Descargar`;

      dlBtn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        dlBtn.innerHTML = `${ICO.spin} Descargando...`;
        dlBtn.style.pointerEvents = "none";
        try {
          if (video) {
            const name = extractFileName(video.src || video.currentSrc, video, "video");
            await downloadVideoSmart(video, name, null);
          } else if (img?.src) {
            const name = extractFileName(img.src, img, "photo");
            await downloadUrl(img.src, name);
          }
          dlBtn.innerHTML = `${ICO.ok} ¡Listo!`;
          setTimeout(() => { dlBtn.innerHTML = `${ICO.dl} Descargar`; dlBtn.style.pointerEvents = ""; }, 2500);
        } catch (err) {
          log.e(err.message);
          dlBtn.innerHTML = `${ICO.dl} Descargar`;
          dlBtn.style.pointerEvents = "";
        }
      });

      viewer.appendChild(dlBtn);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    log.i("Media viewer observer activo");
  }

  // =============================================
  // STORIES HANDLER
  // =============================================
  function watchStories() {
    const v = detectVersion();

    const observer = new MutationObserver(() => {
      const container = document.querySelector(SEL[v].stories);
      if (!container || container.querySelector(".tg-grab-viewer-btn")) return;

      const dlBtn = document.createElement("button");
      dlBtn.className = "tg-grab-viewer-btn";
      dlBtn.style.bottom = "70px";
      dlBtn.innerHTML = `${ICO.dl} Descargar Story`;

      dlBtn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        dlBtn.innerHTML = `${ICO.spin} Descargando...`;

        const video = container.querySelector(SEL[v].storyVideo);
        if (video) {
          const vSrc = video.src || video.currentSrc || "";
          await downloadVideoSmart(video, extractFileName(vSrc, video, "video"), null);
        } else {
          const imgs = container.querySelectorAll(SEL[v].storyImg);
          const img = imgs[imgs.length - 1];
          if (img?.src) await downloadUrl(img.src, extractFileName(img.src, img, "photo"));
        }

        dlBtn.innerHTML = `${ICO.ok} ¡Listo!`;
        setTimeout(() => { dlBtn.innerHTML = `${ICO.dl} Descargar Story`; }, 2500);
      });

      container.appendChild(dlBtn);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    log.i("Stories observer activo");
  }

  // =============================================
  // RESTRICTED CONTENT BYPASS
  // =============================================
  function bypassRestrictions() {
    if (!S.restrictedEnabled) return;

    // Allow right-click
    document.addEventListener("contextmenu", (e) => e.stopPropagation(), true);
    ["copy", "cut", "selectstart", "dragstart"].forEach((ev) => {
      document.addEventListener(ev, (e) => e.stopPropagation(), true);
    });

    // Remove no-forwards classes on new elements
    new MutationObserver((muts) => {
      muts.forEach((m) => m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        n.classList?.remove("no-forwards");
        n.removeAttribute?.("data-noforwards");
        n.querySelectorAll?.(".no-forwards, [data-noforwards]").forEach((el) => {
          el.classList.remove("no-forwards");
          el.removeAttribute("data-noforwards");
        });
      }));
    }).observe(document.body, { childList: true, subtree: true });

    log.i("Restricciones eliminadas");
  }

  // =============================================
  // AUTO-SCROLL SCANNER
  // =============================================
  async function autoScrollScan(onMedia, onProgress, signal) {
    const v = detectVersion();
    const containerSel = v === "K" ? ".bubbles .scrollable, .bubbles-inner" : ".MessageList, .messages-container";
    const scrollEl = document.querySelector(containerSel)?.closest(".scrollable") || document.querySelector(containerSel);

    if (!scrollEl) { log.w("No se encontró scroll container"); return []; }

    const allMedia = [];
    const seenSrc = new Set();
    let noNewCount = 0;
    let scrollAttempts = 0;
    const MAX_ATTEMPTS = 200;

    // First scan visible content
    const msgs = document.querySelectorAll(SEL[v].message);
    msgs.forEach((msg) => {
      findMediaInMessage(msg, v).forEach((item) => {
        const key = item.src || item.name;
        if (!seenSrc.has(key)) {
          seenSrc.add(key);
          allMedia.push(item);
          if (onMedia) onMedia(item, allMedia.length);
        }
      });
    });

    if (onProgress) onProgress("scanning", allMedia.length, null);

    // Scroll up to find older messages
    while (scrollAttempts < MAX_ATTEMPTS) {
      if (signal?.aborted) break;

      const prevCount = allMedia.length;
      scrollEl.scrollTop -= scrollEl.clientHeight * 0.8;
      await sleep(400);

      const newMsgs = document.querySelectorAll(SEL[v].message);
      newMsgs.forEach((msg) => {
        findMediaInMessage(msg, v).forEach((item) => {
          const key = item.src || item.name;
          if (!seenSrc.has(key)) {
            seenSrc.add(key);
            allMedia.push(item);
            if (onMedia) onMedia(item, allMedia.length);
          }
        });
      });

      if (allMedia.length === prevCount) {
        noNewCount++;
        if (noNewCount >= 5) break; // No more new media
      } else {
        noNewCount = 0;
      }

      scrollAttempts++;
      if (onProgress) onProgress("scanning", allMedia.length, scrollAttempts);
    }

    // Scroll back to bottom
    scrollEl.scrollTop = scrollEl.scrollHeight;

    if (onProgress) onProgress("done", allMedia.length, scrollAttempts);
    log.i(`Auto-scroll scan: ${allMedia.length} media encontrados en ${scrollAttempts} scrolls`);
    return allMedia;
  }

  // =============================================
  // SCAN VISIBLE ONLY (quick)
  // =============================================
  function scanVisible() {
    const v = detectVersion();
    const msgs = document.querySelectorAll(SEL[v].message);
    const counts = { photos: 0, videos: 0, gifs: 0, docs: 0, audios: 0 };
    const all = [];

    msgs.forEach((msg) => {
      findMediaInMessage(msg, v).forEach((item) => {
        all.push(item);
        if (item.type === "photo") counts.photos++;
        else if (item.type === "video") counts.videos++;
        else if (item.type === "gif") counts.gifs++;
        else if (item.type === "doc") counts.docs++;
        else if (item.type === "audio") counts.audios++;
      });
    });

    return { counts, total: all.length, media: all };
  }

  // =============================================
  // GALLERY PREVIEW
  // =============================================
  function openGallery(mediaItems) {
    if (S.galleryOpen) return;
    S.galleryOpen = true;

    const overlay = document.createElement("div");
    overlay.className = "tg-gallery-overlay";
    overlay.id = "tg-gallery";

    const selectedSet = new Set();
    let filterType = "all";
    let dlInProgress = false;

    function getFiltered() {
      if (filterType === "all") return mediaItems;
      return mediaItems.filter((m) => m.type === filterType);
    }

    function render() {
      const filtered = getFiltered();
      const selCount = selectedSet.size;
      const totalItems = filtered.length;

      overlay.innerHTML = `
        <div class="tg-gallery-header">
          <div>
            <div class="tg-gallery-title">📸 Galería — ${mediaItems.length} archivos</div>
            <div class="tg-gallery-subtitle">${selCount} seleccionados de ${totalItems} visibles</div>
          </div>
          <div class="tg-gallery-actions">
            <button class="tg-gallery-btn primary" id="tgGalDl" ${selCount === 0 ? "disabled" : ""}>
              ⬇ Descargar ${selCount > 0 ? `(${selCount})` : "seleccionados"}
            </button>
            <button class="tg-gallery-btn close-btn" id="tgGalClose">✕</button>
          </div>
        </div>
        <div class="tg-gallery-filters">
          ${[
            ["all", "Todos", mediaItems.length],
            ["photo", "📸 Fotos", mediaItems.filter((m) => m.type === "photo").length],
            ["video", "🎬 Videos", mediaItems.filter((m) => m.type === "video").length],
            ["gif", "🎭 GIFs", mediaItems.filter((m) => m.type === "gif").length],
            ["audio", "🎵 Audio", mediaItems.filter((m) => m.type === "audio").length],
            ["doc", "📎 Docs", mediaItems.filter((m) => m.type === "doc").length],
          ].filter(([,, c]) => c > 0).map(([t, label, count]) =>
            `<button class="tg-gallery-chip ${filterType === t ? "active" : ""}" data-filter="${t}">${label} (${count})</button>`
          ).join("")}
          <button class="tg-gallery-select-all" id="tgGalSelAll">
            ${selCount === totalItems ? "Deseleccionar todo" : "Seleccionar todo"}
          </button>
        </div>
        <div class="tg-gallery-grid" id="tgGalGrid">
          ${filtered.map((item, i) => {
            const idx = mediaItems.indexOf(item);
            const isSelected = selectedSet.has(idx);
            return `
              <div class="tg-gallery-item ${isSelected ? "selected" : ""}" data-idx="${idx}">
                <div class="tg-gallery-item-check">${isSelected ? "✓" : ""}</div>
                ${item.type === "doc"
                  ? `<div class="tg-gallery-item-doc">
                      <div class="tg-gallery-item-doc-icon">📄</div>
                      <div class="tg-gallery-item-doc-name">${item.name}</div>
                    </div>`
                  : item.type === "audio"
                    ? `<div class="tg-gallery-item-doc">
                        <div class="tg-gallery-item-doc-icon">🎵</div>
                        <div class="tg-gallery-item-doc-name">${item.name}</div>
                      </div>`
                    : item.thumb
                      ? `<img src="${item.thumb}" loading="lazy" alt="">`
                      : `<div class="tg-gallery-item-doc">
                          <div class="tg-gallery-item-doc-icon">${item.type === "video" ? "🎬" : item.type === "gif" ? "🎭" : "📸"}</div>
                          <div class="tg-gallery-item-doc-name">${item.name}</div>
                        </div>`
                }
                <div class="tg-gallery-item-badge">${
                  item.type === "photo" ? "IMG" : item.type === "video" ? "VID" : item.type === "gif" ? "GIF" : item.type === "audio" ? "AUD" : "DOC"
                }</div>
              </div>`;
          }).join("")}
          ${filtered.length === 0 ? '<div class="tg-gallery-empty">No se encontró multimedia de este tipo</div>' : ""}
        </div>
        <div class="tg-gallery-footer">
          <div class="tg-gallery-footer-info" id="tgGalFooterInfo">${selCount} seleccionados</div>
          <div class="tg-gallery-footer-progress" id="tgGalProgress">
            <div class="tg-gallery-footer-progress-fill" id="tgGalProgressFill"></div>
          </div>
        </div>
      `;

      // Event listeners
      overlay.querySelector("#tgGalClose").onclick = closeGallery;

      overlay.querySelectorAll(".tg-gallery-chip").forEach((chip) => {
        chip.onclick = () => { filterType = chip.dataset.filter; render(); };
      });

      overlay.querySelector("#tgGalSelAll").onclick = () => {
        const filtered = getFiltered();
        const allIdxs = filtered.map((m) => mediaItems.indexOf(m));
        const allSelected = allIdxs.every((i) => selectedSet.has(i));
        if (allSelected) {
          allIdxs.forEach((i) => selectedSet.delete(i));
        } else {
          allIdxs.forEach((i) => selectedSet.add(i));
        }
        render();
      };

      overlay.querySelectorAll(".tg-gallery-item").forEach((el) => {
        el.onclick = () => {
          const idx = parseInt(el.dataset.idx);
          if (selectedSet.has(idx)) selectedSet.delete(idx);
          else selectedSet.add(idx);
          render();
        };
      });

      overlay.querySelector("#tgGalDl").onclick = async () => {
        if (dlInProgress || selectedSet.size === 0) return;
        dlInProgress = true;
        const items = [...selectedSet].map((i) => mediaItems[i]);
        const prog = overlay.querySelector("#tgGalProgress");
        const progFill = overlay.querySelector("#tgGalProgressFill");
        const info = overlay.querySelector("#tgGalFooterInfo");
        const dlBtn = overlay.querySelector("#tgGalDl");
        prog.classList.add("active");
        dlBtn.disabled = true;
        dlBtn.textContent = "⏳ Descargando...";
        S.abortController = new AbortController();

        for (let i = 0; i < items.length; i++) {
          if (S.abortController.signal.aborted) break;
          info.textContent = `Descargando ${i + 1} / ${items.length}: ${items[i].name}`;
          progFill.style.width = `${Math.round(((i + 1) / items.length) * 100)}%`;
          try {
            await downloadItem(items[i]);
          } catch (e) { log.e(e.message); }
          await sleep(200);
        }

        info.textContent = `✅ ${items.length} archivos descargados`;
        dlBtn.textContent = "⬇ ¡Completo!";
        dlInProgress = false;
        setTimeout(() => {
          prog.classList.remove("active");
          dlBtn.disabled = false;
          dlBtn.textContent = `⬇ Descargar (${selectedSet.size})`;
        }, 3000);
      };
    }

    function closeGallery() {
      overlay.remove();
      S.galleryOpen = false;
      S.abortController?.abort();
    }

    // Close with Escape
    const onKey = (e) => { if (e.key === "Escape") { closeGallery(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    render();
  }

  // =============================================
  // TOAST
  // =============================================
  let toastEl = null;
  function showToast(title, current, total) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "tg-grab-toast";
      document.body.appendChild(toastEl);
    }
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    toastEl.innerHTML = `
      <div class="tg-grab-toast-title"><span>⬇</span><span>${title}</span></div>
      <div class="tg-grab-toast-bar"><div class="tg-grab-toast-fill" style="width:${pct}%"></div></div>
      <div class="tg-grab-toast-info"><span>${current} / ${total}</span><span>${pct}%</span></div>
    `;
    toastEl.style.display = "block";
  }
  function hideToast() { if (toastEl) toastEl.style.display = "none"; }

  // =============================================
  // BULK DOWNLOAD
  // =============================================
  async function bulkDownload(types, media) {
    if (S.downloading) return;
    S.downloading = true;
    S.abortController = new AbortController();

    const typeMap = { photos: ["photo"], videos: ["video"], gifs: ["gif"], docs: ["doc"], audios: ["audio"] };
    const allowed = types.flatMap((t) => typeMap[t] || []);
    const filtered = (media || scanVisible().media).filter((m) => allowed.includes(m.type));

    if (!filtered.length) {
      showToast("No se encontró multimedia", 0, 0);
      setTimeout(hideToast, 2000);
      S.downloading = false;
      return;
    }

    showToast("Descargando...", 0, filtered.length);
    for (let i = 0; i < filtered.length; i++) {
      if (S.abortController.signal.aborted) break;
      try {
        await downloadItem(filtered[i], (pct) => showToast(`Descargando ${filtered[i].name}`, i, filtered.length));
        showToast("Descargando...", i + 1, filtered.length);
      } catch (e) { log.e(e.message); }
      await sleep(200);
    }

    showToast("✅ ¡Descarga completa!", filtered.length, filtered.length);
    setTimeout(hideToast, 3000);
    S.downloading = false;
  }

  // =============================================
  // MESSAGE HANDLER (from popup / background)
  // =============================================
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        switch (msg.action) {
          case "ping":
            sendResponse({ status: "active", version: detectVersion() });
            break;
          case "scan":
            sendResponse(scanVisible());
            break;
          case "bulkDownload":
            bulkDownload(msg.types || ["photos", "videos", "gifs", "docs"]);
            sendResponse({ started: true });
            break;
          case "autoScrollScan": {
            const ac = new AbortController();
            S.abortController = ac;
            autoScrollScan(null, (status, count) => {
              try { chrome.runtime.sendMessage({ action: "scanProgress", status, count }); } catch(_) {}
            }, ac.signal).then((media) => {
              S.scannedMedia = media;
              try { chrome.runtime.sendMessage({ action: "scanComplete", count: media.length }); } catch(_) {}
            });
            sendResponse({ started: true });
            break;
          }
          case "stopScan":
            S.abortController?.abort();
            sendResponse({ stopped: true });
            break;
          case "openGallery": {
            const media = S.scannedMedia.length ? S.scannedMedia : scanVisible().media;
            openGallery(media);
            sendResponse({ opened: true });
            break;
          }
          case "autoScrollAndGallery": {
            const ac2 = new AbortController();
            S.abortController = ac2;
            showToast("Escaneando chat...", 0, 0);
            autoScrollScan(
              (item, count) => showToast(`Escaneando... ${count} encontrados`, count, 0),
              null, ac2.signal
            ).then((media) => {
              hideToast();
              S.scannedMedia = media;
              openGallery(media);
            });
            sendResponse({ started: true });
            break;
          }
          case "updateSettings":
            if (msg.buttonsEnabled !== undefined) S.buttonsEnabled = msg.buttonsEnabled;
            if (msg.restrictedEnabled !== undefined) S.restrictedEnabled = msg.restrictedEnabled;
            if (msg.folderName) S.folderName = msg.folderName;
            if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({
                buttonsEnabled: S.buttonsEnabled,
                restrictedEnabled: S.restrictedEnabled,
                folderName: S.folderName,
              });
            }
            sendResponse({ ok: true });
            break;
          case "getProgress":
            sendResponse({ downloading: S.downloading });
            break;
          case "command":
            if (msg.command === "download-current") {
              const vv = detectVersion();
              const viewer = document.querySelector(SEL[vv].mediaViewer);
              if (viewer) { const btn = viewer.querySelector(".tg-grab-viewer-btn"); if (btn) btn.click(); }
            }
            if (msg.command === "open-gallery") {
              const media = S.scannedMedia.length ? S.scannedMedia : scanVisible().media;
              openGallery(media);
            }
            break;
          default:
            sendResponse({ error: "Unknown action" });
        }
      } catch (e) {
        log.e("Message handler error: " + e.message);
        sendResponse({ error: e.message });
      }
      return true;
    });
    log.i("Message listener registrado");
  } else {
    log.w("chrome.runtime.onMessage no disponible");
  }

  // =============================================
  // OBSERVER — watch for new messages
  // =============================================
  function startObserver() {
    if (S.observerActive) return;
    const v = detectVersion();
    const container = document.querySelector(SEL[v].chatContainer);
    if (!container) { setTimeout(startObserver, 2000); return; }

    new MutationObserver(debounce(() => injectButtons(), 400)).observe(container, { childList: true, subtree: true });
    S.observerActive = true;
    log.i("Chat observer activo");
    injectButtons();
  }

  // =============================================
  // INIT
  // =============================================
  function init() {
    const v = detectVersion();
    log.i(`Inicializando v2 — Versión ${v}`);

    function startAll() {
      injectInterceptor();
      bypassRestrictions();
      watchMediaViewer();
      watchStories();

      const wait = setInterval(() => {
        const chat = document.querySelector(SEL[v].chatContainer);
        if (chat) { clearInterval(wait); startObserver(); }
      }, 1000);

      log.i("TG Media Grabber Pro v2 listo ✓");
    }

    // Protect against chrome API not being available
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["buttonsEnabled", "restrictedEnabled", "folderName"], (data) => {
        if (chrome.runtime.lastError) { log.w("Storage read error, using defaults"); }
        else {
          if (data.buttonsEnabled === false) S.buttonsEnabled = false;
          if (data.restrictedEnabled === false) S.restrictedEnabled = false;
          if (data.folderName) S.folderName = data.folderName;
        }
        startAll();
      });
    } else {
      log.w("chrome.storage no disponible, usando defaults");
      startAll();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
