// Marginote content script.
//
// Injected into all URLs at document_idle. In Prompt 2 this will own:
//   - selection detection and anchoring (anchorData in storage.js)
//   - the floating "save annotation" affordance
//   - re-highlighting previously saved annotations when the page loads
//
// Intentionally empty in Prompt 1 (scaffolding only). Errors in this script
// must never throw up to the host page — wrap every chrome.storage call in
// try/catch and surface failures via console.warn with the `[marginote]` tag.
