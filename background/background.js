// Marginote background service worker (Manifest V3, ES module).
//
// Role:
//   - Run storage migrations on install/startup so older records are brought
//     up to the current schemaVersion before any UI reads them.
//   - Handle the `open-dashboard` keyboard command (Ctrl/Cmd+Shift+M) by
//     opening the dashboard in a new tab.
//   - Own the "Delete Marginote annotation" context menu item. The content
//     script arms/disarms the item on each `contextmenu` event (only visible
//     when the right-clicked element is a Marginote highlight), and this
//     worker performs the delete + notifies the content script to unwrap
//     the span in place.
//   - Proxy storage reads/writes from the content script (which is a classic
//     script and can't import the ES-module storage utility).

import {
  migrate,
  getAnnotations,
  saveAnnotation,
  deleteAnnotation,
  getActiveProjectId,
  getProjects,
  MARGINOTE_GENERAL_PROJECT_ID,
} from '../utils/storage.js';

const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');
const DELETE_MENU_ID = 'marginote-delete';

/**
 * Holds the annotation id + tab id captured on the most recent armDeleteMenu
 * message. Consumed (and cleared) when the delete menu item is clicked.
 * @type {{annotationId: string, tabId: number} | null}
 */
let pendingDelete = null;

async function ensureContextMenu() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: DELETE_MENU_ID,
      title: 'Delete Marginote annotation',
      contexts: ['page'],
      visible: false,
      documentUrlPatterns: ['<all_urls>'],
    });
  } catch (err) {
    console.warn('[marginote] ensureContextMenu failed', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await migrate();
  } catch (err) {
    console.warn('[marginote] migrate on install failed', err);
  }
  await ensureContextMenu();
});

chrome.runtime.onStartup?.addListener(async () => {
  try {
    await migrate();
  } catch (err) {
    console.warn('[marginote] migrate on startup failed', err);
  }
  await ensureContextMenu();
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-dashboard') return;
  try {
    await chrome.tabs.create({ url: DASHBOARD_URL });
  } catch (err) {
    console.warn('[marginote] open-dashboard command failed', err);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== DELETE_MENU_ID) return;
  const target = pendingDelete;
  pendingDelete = null;
  try {
    await chrome.contextMenus.update(DELETE_MENU_ID, { visible: false });
  } catch {
    // Menu may have been torn down; ignore.
  }
  if (!target) return;
  try {
    await deleteAnnotation(target.annotationId);
  } catch (err) {
    console.warn('[marginote] deleteAnnotation failed', err);
    return;
  }
  const tabId = target.tabId ?? tab?.id;
  if (typeof tabId === 'number') {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'marginote:unwrapAnnotation',
        annotationId: target.annotationId,
      });
    } catch (err) {
      // Tab may have navigated; not fatal.
      console.warn('[marginote] unwrap dispatch failed', err);
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  (async () => {
    try {
      switch (msg.type) {
        case 'marginote:getAnnotationsForUrl': {
          const [annotations, projects] = await Promise.all([
            getAnnotations({ pageUrl: msg.url }),
            getProjects(),
          ]);
          sendResponse({ ok: true, annotations, projects });
          return;
        }
        case 'marginote:saveAnnotation': {
          const saved = await saveAnnotation(msg.annotation);
          sendResponse({ ok: true, annotation: saved });
          return;
        }
        case 'marginote:deleteAnnotation': {
          await deleteAnnotation(msg.id);
          sendResponse({ ok: true });
          return;
        }
        case 'marginote:getActiveProjectContext': {
          const [id, projects] = await Promise.all([
            getActiveProjectId(),
            getProjects(),
          ]);
          const activeProjectId =
            id || projects[0]?.id || MARGINOTE_GENERAL_PROJECT_ID;
          sendResponse({ ok: true, activeProjectId, projects });
          return;
        }
        case 'marginote:armDeleteMenu': {
          pendingDelete = {
            annotationId: msg.annotationId,
            tabId: sender.tab?.id ?? -1,
          };
          try {
            await chrome.contextMenus.update(DELETE_MENU_ID, { visible: true });
          } catch (err) {
            // Menu may not yet exist on this run; recreate and retry.
            await ensureContextMenu();
            await chrome.contextMenus.update(DELETE_MENU_ID, { visible: true });
          }
          sendResponse({ ok: true });
          return;
        }
        case 'marginote:disarmDeleteMenu': {
          pendingDelete = null;
          try {
            await chrome.contextMenus.update(DELETE_MENU_ID, { visible: false });
          } catch {
            // Menu not present; fine.
          }
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.warn('[marginote] message handler failed', msg.type, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // keep the channel open for the async sendResponse above
});
