// Marginote background service worker (Manifest V3, ES module).
//
// Role:
//   - Run storage migrations on install/startup so older records are brought
//     up to the current schemaVersion before any UI reads them.
//   - On first install, ensure a default "General" project exists and is set
//     as the active project.
//   - Keep the toolbar badge in sync with the active project: its background
//     matches the project color, its text is the first letter (uppercased)
//     of the project name (or "•" if the name starts with a non-letter).
//     Badge updates are triggered by chrome.storage.onChanged events on
//     `activeProjectId` or `projects`.
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
  setActiveProjectId,
  getProjects,
  saveProject,
  getSubgroups,
  saveSubgroup,
  MARGINOTE_GENERAL_PROJECT_ID,
} from '../utils/storage.js';

const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');
const DELETE_MENU_ID = 'marginote-delete';
const GENERAL_PROJECT_NAME = 'General';
const GENERAL_PROJECT_COLOR = '#6B7280';

/**
 * Holds the annotation id + tab id captured on the most recent armDeleteMenu
 * message. Consumed (and cleared) when the delete menu item is clicked.
 * @type {{annotationId: string, tabId: number} | null}
 */
let pendingDelete = null;

async function ensureContextMenu() {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create(
      {
        id: DELETE_MENU_ID,
        title: 'Delete Marginote annotation',
        contexts: ['page'],
        visible: false,
        documentUrlPatterns: ['<all_urls>'],
      },
      // Callback is required to consume chrome.runtime.lastError — otherwise
      // Chrome logs "Unchecked runtime.lastError: duplicate id" when the menu
      // state persists across a service-worker cold start and create() loses
      // the race with the prior session's menu.
      () => {
        const err = chrome.runtime.lastError;
        if (!err) return;
        if (/duplicate id/i.test(err.message || '')) return;
        console.warn('[marginote] contextMenus.create failed', err.message);
      },
    );
  } catch (err) {
    console.warn('[marginote] ensureContextMenu failed', err);
  }
}

/**
 * Compute the single-character badge label for a project name:
 * the first letter uppercased, or "•" if the first character isn't a letter.
 * @param {string} name
 * @returns {string}
 */
function badgeLetterFor(name) {
  const ch = (name || '').trim().charAt(0);
  return /[A-Za-z]/.test(ch) ? ch.toUpperCase() : '•';
}

/**
 * Read the active project + projects list and push the result to the badge.
 * If no active project can be resolved, the badge is cleared.
 */
async function updateBadge() {
  try {
    const [activeId, projects] = await Promise.all([
      getActiveProjectId(),
      getProjects(),
    ]);
    const active =
      projects.find((p) => p.id === activeId) ||
      projects.find((p) => p.id === MARGINOTE_GENERAL_PROJECT_ID) ||
      projects[0] ||
      null;
    if (!active) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ color: active.color });
    await chrome.action.setBadgeText({ text: badgeLetterFor(active.name) });
  } catch (err) {
    console.warn('[marginote] updateBadge failed', err);
  }
}

/**
 * Guarantee a "General" project exists and an active project is selected.
 * Runs on install. migrate() already inserts General if missing; this also
 * seeds activeProjectId when the store has never had one.
 */
async function ensureDefaultProject() {
  try {
    const projects = await getProjects();
    const general = projects.find((p) => p.id === MARGINOTE_GENERAL_PROJECT_ID);
    if (!general) {
      // migrate() should have created it, but be defensive.
      await saveProject({
        id: MARGINOTE_GENERAL_PROJECT_ID,
        name: GENERAL_PROJECT_NAME,
        color: GENERAL_PROJECT_COLOR,
      });
    }
    const activeId = await getActiveProjectId();
    if (!activeId) {
      await setActiveProjectId(MARGINOTE_GENERAL_PROJECT_ID);
    }
  } catch (err) {
    console.warn('[marginote] ensureDefaultProject failed', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await migrate();
  } catch (err) {
    console.warn('[marginote] migrate on install failed', err);
  }
  await ensureDefaultProject();
  await ensureContextMenu();
  await updateBadge();
});

chrome.runtime.onStartup?.addListener(async () => {
  try {
    await migrate();
  } catch (err) {
    console.warn('[marginote] migrate on startup failed', err);
  }
  await ensureContextMenu();
  await updateBadge();
});

// Live badge updates: when the popup (or anywhere else) switches the active
// project or renames/recolors the active project, push a fresh badge.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('activeProjectId' in changes) && !('projects' in changes)) return;
  updateBadge();
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
          const subgroups = await getSubgroups(activeProjectId);
          sendResponse({ ok: true, activeProjectId, projects, subgroups });
          return;
        }
        case 'marginote:createSubgroup': {
          const saved = await saveSubgroup({
            projectId: msg.projectId,
            name: msg.name,
          });
          sendResponse({ ok: true, subgroup: saved });
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
