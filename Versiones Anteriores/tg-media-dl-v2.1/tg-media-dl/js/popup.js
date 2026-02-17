/**
 * TG Media Grabber Pro v2 — Popup Script
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

  // --- Cards ---
  document.querySelectorAll(".card").forEach((c) => {
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
        statusTxt.textContent = "Abre web.telegram.org";
        btnGallery.disabled = true;
        btnBulk.disabled = true;
        btnScan.disabled = true;
      }
    });
  }

  // --- Quick scan ---
  btnScan.addEventListener("click", () => {
    btnScan.textContent = "🔍 Escaneando...";
    btnScan.disabled = true;
    send({ action: "scan" }, (r) => {
      btnScan.textContent = "🔍 Scan rápido (solo visible)";
      btnScan.disabled = false;
      if (r?.counts) {
        $("#cPhotos").textContent = r.counts.photos + " enc.";
        $("#cVideos").textContent = r.counts.videos + " enc.";
        $("#cGifs").textContent = r.counts.gifs + " enc.";
        $("#cDocs").textContent = r.counts.docs + " enc.";
      }
    });
  });

  // --- Gallery (auto-scroll + preview) ---
  btnGallery.addEventListener("click", () => {
    btnGallery.textContent = "⏳ Escaneando chat...";
    btnGallery.disabled = true;
    send({ action: "autoScrollAndGallery" }, () => {
      // Gallery opens in content script
      setTimeout(() => {
        btnGallery.textContent = "🎨 Escanear + Galería Preview";
        btnGallery.disabled = false;
      }, 2000);
    });
  });

  // --- Bulk download ---
  btnBulk.addEventListener("click", () => {
    if (!selectedTypes.size) { statusTxt.textContent = "Selecciona al menos un tipo"; return; }
    btnBulk.disabled = true;
    btnBulk.textContent = "⏳ Descargando...";
    prog.classList.add("on");

    send({ action: "bulkDownload", types: [...selectedTypes] }, () => {
      const poll = setInterval(() => {
        send({ action: "getProgress" }, (r) => {
          if (r && !r.downloading) {
            clearInterval(poll);
            btnBulk.disabled = false;
            btnBulk.textContent = "⬇ Descargar todo del chat";
            progFill.style.width = "100%";
            progTxt.textContent = "Completo";
            progPct.textContent = "100%";
            setTimeout(() => prog.classList.remove("on"), 3000);
          }
        });
      }, 1200);
    });
  });

  // --- Listen for scan progress ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "scanProgress") {
      statusTxt.textContent = `Escaneando... ${msg.count} encontrados`;
    }
    if (msg.action === "scanComplete") {
      statusTxt.textContent = `✓ ${msg.count} archivos encontrados`;
    }
  });

  // --- Helpers ---
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
