/**
 * TG Media Grabber Pro v3.1 — Popup Script
 */
document.addEventListener("DOMContentLoaded", () => {
  const $ = (s) => document.querySelector(s);
  const dot = $("#dot");
  const statusTxt = $("#statusTxt");
  const btnGallery = $("#btnGallery");
  const btnBulk = $("#btnBulk");
  const btnScan = $("#btnScan");
  const prog = $("#prog");
  const progFill = $("#progFill");
  const progTxt = $("#progTxt");
  const progPct = $("#progPct");
  const folder = $("#folder");
  const togRestrict = $("#togRestrict");
  const togButtons = $("#togButtons");

  const selectedTypes = new Set(["photos", "videos", "gifs", "docs"]);

  // --- Card selection ---
  document.querySelectorAll(".type-card").forEach((c) => {
    c.addEventListener("click", () => {
      const t = c.dataset.type;
      if (selectedTypes.has(t)) { selectedTypes.delete(t); c.classList.remove("sel"); }
      else { selectedTypes.add(t); c.classList.add("sel"); }
    });
  });

  // --- Toggles ---
  togRestrict.addEventListener("click", () => {
    togRestrict.classList.toggle("on");
    const v = togRestrict.classList.contains("on");
    save({ restrictedEnabled: v });
    send({ action: "updateSettings", restrictedEnabled: v });
  });
  togButtons.addEventListener("click", () => {
    togButtons.classList.toggle("on");
    const v = togButtons.classList.contains("on");
    save({ buttonsEnabled: v });
    send({ action: "updateSettings", buttonsEnabled: v });
  });

  // --- Folder ---
  folder.addEventListener("change", () => {
    const v = folder.value.trim() || "TG_Media";
    folder.value = v;
    save({ folderName: v });
    send({ action: "updateSettings", folderName: v });
  });

  // --- Ping ---
  function ping() {
    send({ action: "ping" }, (r) => {
      if (r?.status === "active") {
        dot.classList.add("on");
        statusTxt.textContent = `Conectado — Telegram Web ${r.version}`;
        btnGallery.disabled = false;
        btnBulk.disabled = false;
        btnScan.disabled = false;
      } else {
        dot.classList.remove("on");
        statusTxt.textContent = "Abre web.telegram.org primero";
        btnGallery.disabled = true;
        btnBulk.disabled = true;
        btnScan.disabled = true;
      }
    });
  }

  // --- Quick scan ---
  btnScan.addEventListener("click", () => {
    setLoading(btnScan, true);
    send({ action: "scan" }, (r) => {
      setLoading(btnScan, false);
      if (r?.counts) {
        $("#cPhotos").textContent = r.counts.photos || 0;
        $("#cVideos").textContent = r.counts.videos || 0;
        $("#cGifs").textContent = r.counts.gifs || 0;
        $("#cDocs").textContent = r.counts.docs || 0;
        statusTxt.textContent = `⚡ Scan: ${(r.counts.photos||0)+(r.counts.videos||0)+(r.counts.gifs||0)+(r.counts.docs||0)} visibles`;
      }
    });
  });

  // --- Gallery (auto-scroll + preview) ---
  btnGallery.addEventListener("click", () => {
    setLoading(btnGallery, true);
    statusTxt.textContent = "🔍 Escaneando chat completo...";
    send({ action: "autoScrollAndGallery" }, () => {
      // Gallery opens in content script, restore button after delay
      setTimeout(() => setLoading(btnGallery, false), 3000);
    });
  });

  // --- Bulk download ---
  btnBulk.addEventListener("click", () => {
    if (!selectedTypes.size) { statusTxt.textContent = "⚠ Selecciona al menos un tipo"; return; }
    setLoading(btnBulk, true);
    prog.classList.add("on");

    send({ action: "bulkDownload", types: [...selectedTypes] }, () => {
      const poll = setInterval(() => {
        send({ action: "getProgress" }, (r) => {
          if (r && !r.downloading) {
            clearInterval(poll);
            setLoading(btnBulk, false);
            progFill.style.width = "100%";
            progTxt.textContent = "✅ Completo";
            progPct.textContent = "100%";
            setTimeout(() => prog.classList.remove("on"), 4000);
          }
        });
      }, 1200);
    });
  });

  // --- Listen for scan progress ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "scanProgress") {
      statusTxt.textContent = `🔍 ${msg.count} archivos encontrados...`;
    }
    if (msg.action === "scanComplete") {
      statusTxt.textContent = `✅ ${msg.count} archivos encontrados`;
      setLoading(btnGallery, false);
    }
  });

  // --- Helpers ---
  function setLoading(btn, loading) {
    if (loading) {
      btn.classList.add("loading");
      btn.disabled = true;
    } else {
      btn.classList.remove("loading");
      btn.disabled = false;
    }
  }
  function send(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, msg, (r) => {
          if (chrome.runtime.lastError) { if (cb) cb(null); }
          else { if (cb) cb(r); }
        });
      } else { if (cb) cb(null); }
    });
  }
  function save(d) { chrome.storage.local.set(d); }
  function load() {
    chrome.storage.local.get(["buttonsEnabled", "restrictedEnabled", "folderName"], (d) => {
      if (d.buttonsEnabled === false) togButtons.classList.remove("on");
      if (d.restrictedEnabled === false) togRestrict.classList.remove("on");
      if (d.folderName) folder.value = d.folderName;
    });
  }

  load();
  ping();
});
