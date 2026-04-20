// Marginote background service worker (Manifest V3, ES module).
//
// Role:
//   - Listen for changes to the active project and update the toolbar badge
//     so the user always sees which project they're annotating into.
//   - Register and respond to context-menu clicks (right-click → "Save to
//     Marginote") — wired up in a later prompt.
//   - Handle the `open-dashboard` keyboard command (Ctrl/Cmd+Shift+M) by
//     opening the dashboard in a new tab.
//   - Run storage migrations on install/update so older records are brought
//     up to the current schemaVersion before any UI reads them.
//
// Only the minimum wiring lives here in Prompt 1; feature work lands in
// later prompts.

import { migrate } from '../utils/storage.js';

const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await migrate();
  } catch (err) {
    console.warn('[marginote] migrate on install failed', err);
  }
});

chrome.runtime.onStartup?.addListener(async () => {
  try {
    await migrate();
  } catch (err) {
    console.warn('[marginote] migrate on startup failed', err);
  }
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-dashboard') return;
  try {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  } catch (err) {
    console.warn('[marginote] open-dashboard command failed', err);
  }
});
