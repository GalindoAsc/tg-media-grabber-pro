/**
 * TG Media Grabber Pro v2 — Background Service Worker
 */

// Handle downloads
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "download") {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.fileName || "TG_Media/file",
      conflictAction: "uniquify",
      saveAs: false,
    }, (id) => {
      if (chrome.runtime.lastError) {
        console.error("[TG Grabber BG]", chrome.runtime.lastError.message);
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ downloadId: id });
      }
    });
    return true;
  }

  // Forward scan progress to popup
  if (msg.action === "scanProgress" || msg.action === "scanComplete") {
    // Relay to popup if open
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});

// Keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "command", command });
    }
  });
});

// Install defaults
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set({
      buttonsEnabled: true,
      restrictedEnabled: true,
      folderName: "TG_Media",
    });
    console.log("[TG Grabber BG] Defaults set");
  }
});
