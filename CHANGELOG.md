# Changelog

All notable changes to TG Media Grabber Pro will be documented in this file.

## [4.2] — 2026-02-07

### Added
- ⚙️ Configurable max file size setting (skip files above threshold)
- 🔧 Sidebar crash recovery (auto-recover from DOM failures)
- 🛟 Viewer failure bailout (graceful fallback when media viewer breaks)

### Fixed
- Updated README to v4.2

---

## [4.1] — 2026-02-04

### Fixed
- 📸 Album downloads: capture per-photo `data-mid`, enable API download for all items with msgId
- 🔄 Stale loop fix: reduced MAX_STALE to 10, added early exit when content exhausted
- 🎨 Updated icons and rebuilt store ZIP
- 📧 Updated all contact emails to codeaeternum@outlook.com
- 🗑️ Removed unused `scripting` permission (Chrome Web Store rejection fix)

---

## [4.0] — 2026-01-27

### 🎉 Major Release

#### Added
- 🖼️ **Gallery Preview** — visual media browser before downloading
- ⬇️ **Bulk Download** — download all photos, videos, GIFs at once
- 🔍 **Smart Scanning** — cached scan results for instant re-access
- 🚫 **Duplicate Detection** — skip already-downloaded files
- 📊 **Download Progress** — real-time progress bar with ETA
- 📋 **Download History** — track recent downloads
- 🔒 **Restricted Content** — bypass download restrictions
- 🖱️ **Floating Buttons** — one-click download buttons on messages
- 📁 **Custom Folder** — configurable download directory name
- ☕ **Ko-fi Donation** — support the developer
- 💬 **Feedback Modal** — Bug/Feature/Other reports via Google Forms
- 🆕 New logo and branding
- 🇺🇸 English UI
