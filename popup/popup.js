import {
  migrate,
  getProjects,
  getActiveProjectId,
  setActiveProjectId,
} from '../utils/storage.js';

const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');

/**
 * Show a short-lived, non-blocking toast in the popup.
 * @param {string} message
 * @param {'info'|'error'} [kind]
 */
function showToast(message, kind = 'info') {
  const toast = document.getElementById('marginote-popup-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

/**
 * Populate the project switcher and select the active project, if any.
 */
async function renderProjectSwitcher() {
  const select = document.getElementById('marginote-project-switcher');
  if (!select) return;
  try {
    const [projects, activeId] = await Promise.all([
      getProjects(),
      getActiveProjectId(),
    ]);
    select.innerHTML = '';
    for (const project of projects) {
      const opt = document.createElement('option');
      opt.value = project.id;
      opt.textContent = project.name;
      if (project.id === activeId) opt.selected = true;
      select.appendChild(opt);
    }
    if (!activeId && projects.length > 0) {
      select.value = projects[0].id;
    }
  } catch (err) {
    showToast('Failed to load projects', 'error');
    console.warn('[marginote] renderProjectSwitcher failed', err);
  }
}

/**
 * Quick sanity check that chrome.storage.local is readable/writable.
 * Logs to the console; surfaces toast only on failure.
 */
async function verifyStorageRoundTrip() {
  try {
    const key = '__marginote_storage_check__';
    const value = Date.now();
    await chrome.storage.local.set({ [key]: value });
    const read = await chrome.storage.local.get(key);
    await chrome.storage.local.remove(key);
    const ok = read[key] === value;
    console.log('[marginote] storage round-trip', ok ? 'ok' : 'mismatch', read);
    if (!ok) showToast('Storage check failed', 'error');
  } catch (err) {
    console.warn('[marginote] storage check failed', err);
    showToast('Storage unavailable', 'error');
  }
}

function wireEvents() {
  const openBtn = document.getElementById('marginote-open-dashboard');
  const select = document.getElementById('marginote-project-switcher');

  openBtn?.addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: DASHBOARD_URL });
      window.close();
    } catch (err) {
      showToast('Could not open dashboard', 'error');
      console.warn('[marginote] open dashboard failed', err);
    }
  });

  select?.addEventListener('change', async (e) => {
    const id = /** @type {HTMLSelectElement} */ (e.target).value || null;
    try {
      await setActiveProjectId(id);
    } catch (err) {
      showToast('Failed to save selection', 'error');
      console.warn('[marginote] setActiveProjectId failed', err);
    }
  });
}

async function init() {
  try {
    await migrate();
    await renderProjectSwitcher();
    await verifyStorageRoundTrip();
  } catch (err) {
    showToast('Marginote failed to initialize', 'error');
    console.warn('[marginote] popup init failed', err);
  }
  wireEvents();
}

init();
