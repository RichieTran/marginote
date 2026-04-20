import { migrate, getProjects } from '../utils/storage.js';

/**
 * Show a short-lived, non-blocking toast on the dashboard.
 * @param {string} message
 * @param {'info'|'error'} [kind]
 */
function showToast(message, kind = 'info') {
  const toast = document.getElementById('marginote-dashboard-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

/**
 * Placeholder render pass. Prompt 5 replaces this with the real sidebar
 * + annotations table; Prompt 1 only proves end-to-end wiring.
 */
async function render() {
  const host = document.getElementById('marginote-dashboard-projects');
  if (!host) return;
  try {
    const projects = await getProjects();
    host.innerHTML = '';
    for (const project of projects) {
      const row = document.createElement('div');
      row.className = 'marginote-dashboard-project-row';
      row.textContent = project.name;
      host.appendChild(row);
    }
  } catch (err) {
    showToast('Failed to load projects', 'error');
    console.warn('[marginote] dashboard render failed', err);
  }
}

async function init() {
  try {
    await migrate();
    await render();
  } catch (err) {
    showToast('Marginote failed to initialize', 'error');
    console.warn('[marginote] dashboard init failed', err);
  }
}

init();
