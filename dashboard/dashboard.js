import {
  migrate,
  getProjects,
  getAnnotations,
  deleteAnnotation,
} from '../utils/storage.js';

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
 * Truncate a string to at most `max` characters, appending an ellipsis.
 * @param {string} s
 * @param {number} max
 */
function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Format an ISO timestamp as a short human-readable string.
 * @param {string} iso
 */
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || '';
  }
}

/**
 * Render the project sidebar.
 * @param {Array} projects
 */
function renderSidebar(projects) {
  const host = document.getElementById('marginote-dashboard-projects');
  if (!host) return;
  host.innerHTML = '';
  for (const project of projects) {
    const row = document.createElement('div');
    row.className = 'marginote-dashboard-project-row';
    const swatch = document.createElement('span');
    swatch.className = 'marginote-dashboard-project-swatch';
    swatch.style.backgroundColor = project.color || '#6B7280';
    row.appendChild(swatch);
    const name = document.createElement('span');
    name.textContent = project.name;
    row.appendChild(name);
    host.appendChild(row);
  }
}

/**
 * Render the main annotations list.
 * @param {Array} annotations
 * @param {Map<string, object>} projectMap
 */
function renderAnnotations(annotations, projectMap) {
  const host = document.getElementById('marginote-dashboard-annotations');
  if (!host) return;
  host.innerHTML = '';
  if (annotations.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'marginote-dashboard-placeholder';
    empty.textContent = 'No annotations yet — highlight text on any page and click Save.';
    host.appendChild(empty);
    return;
  }
  const sorted = [...annotations].sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || ''),
  );
  for (const a of sorted) {
    const row = document.createElement('article');
    row.className = 'marginote-dashboard-annotation';
    row.dataset.id = a.id;

    const meta = document.createElement('div');
    meta.className = 'marginote-dashboard-annotation-meta';
    const project = projectMap.get(a.projectId);
    const tag = document.createElement('span');
    tag.className = 'marginote-dashboard-tag';
    tag.style.backgroundColor = project?.color || '#6B7280';
    tag.textContent = project?.name || a.projectId || 'Unknown';
    meta.appendChild(tag);
    const time = document.createElement('span');
    time.className = 'marginote-dashboard-time';
    time.textContent = formatDate(a.createdAt);
    meta.appendChild(time);
    row.appendChild(meta);

    const text = document.createElement('blockquote');
    text.className = 'marginote-dashboard-text';
    text.textContent = a.selectedText || '';
    row.appendChild(text);

    const source = document.createElement('div');
    source.className = 'marginote-dashboard-source';
    if (a.pageUrl) {
      const link = document.createElement('a');
      link.href = a.pageUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = truncate(a.pageTitle || a.pageUrl, 90);
      source.appendChild(link);
    } else {
      source.textContent = 'Unknown page';
    }
    row.appendChild(source);

    const actions = document.createElement('div');
    actions.className = 'marginote-dashboard-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'marginote-dashboard-delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {
        await deleteAnnotation(a.id);
        showToast('Annotation deleted');
        await refresh();
      } catch (err) {
        console.warn('[marginote] delete failed', err);
        showToast('Delete failed', 'error');
        del.disabled = false;
      }
    });
    actions.appendChild(del);
    row.appendChild(actions);

    host.appendChild(row);
  }
}

async function refresh() {
  const [projects, annotations] = await Promise.all([
    getProjects(),
    getAnnotations(),
  ]);
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  renderSidebar(projects);
  renderAnnotations(annotations, projectMap);
}

async function init() {
  try {
    await migrate();
    await refresh();
  } catch (err) {
    showToast('Marginote failed to initialize', 'error');
    console.warn('[marginote] dashboard init failed', err);
  }
}

init();
