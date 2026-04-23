import {
  migrate,
  getProjects,
  saveProject,
  deleteProject,
  getSubgroups,
  saveSubgroup,
  deleteSubgroup,
  getAnnotations,
  getActiveProjectId,
  setActiveProjectId,
  MARGINOTE_GENERAL_PROJECT_ID,
} from '../utils/storage.js';

const RECENT_LIMIT = 20;
const RECENT_TEXT_MAX = 60;

const DASHBOARD_URL = chrome.runtime.getURL('dashboard/dashboard.html');

// Curated Notion-inspired palette. Order matters for the swatch grid layout.
const PALETTE = Object.freeze([
  { name: 'Red', hex: '#E03E3E' },
  { name: 'Orange', hex: '#D9730D' },
  { name: 'Yellow', hex: '#DFAB01' },
  { name: 'Green', hex: '#0F7B6C' },
  { name: 'Teal', hex: '#0A8A8A' },
  { name: 'Blue', hex: '#0B6E99' },
  { name: 'Purple', hex: '#6940A5' },
  { name: 'Pink', hex: '#AD1A72' },
  { name: 'Brown', hex: '#64473A' },
  { name: 'Gray', hex: '#6B7280' },
]);

const STATE = {
  projects: /** @type {Array<{id:string,name:string,color:string,createdAt:string}>} */ ([]),
  activeProjectId: /** @type {string|null} */ (null),
  panelOpen: false,
  renamingId: /** @type {string|null} */ (null),
  newProjectColor: PALETTE[0].hex,
  pendingDelete: /** @type {{id:string,name:string}|null} */ (null),
  subgroups: /** @type {Array<{id:string,projectId:string,name:string,createdAt:string}>} */ ([]),
  recentAnnotations: /** @type {Array<object>} */ ([]),
  addingSubgroup: false,
};

// ---- toast ----

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

// ---- data loading ----

async function loadState() {
  const [projects, activeId] = await Promise.all([
    getProjects(),
    getActiveProjectId(),
  ]);
  STATE.projects = projects;
  const existingIds = new Set(projects.map((p) => p.id));
  STATE.activeProjectId = existingIds.has(activeId)
    ? activeId
    : projects[0]?.id || null;

  if (STATE.activeProjectId) {
    const [subgroups, annotations] = await Promise.all([
      getSubgroups(STATE.activeProjectId),
      getAnnotations({ projectId: STATE.activeProjectId }),
    ]);
    STATE.subgroups = subgroups;
    STATE.recentAnnotations = [...annotations]
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, RECENT_LIMIT);
  } else {
    STATE.subgroups = [];
    STATE.recentAnnotations = [];
  }
}

function getActiveProject() {
  return (
    STATE.projects.find((p) => p.id === STATE.activeProjectId) ||
    STATE.projects[0] ||
    null
  );
}

// ---- header ----

function renderHeader() {
  const dot = document.getElementById('marginote-active-dot');
  const name = document.getElementById('marginote-active-name');
  const trigger = document.getElementById('marginote-switcher-trigger');
  const active = getActiveProject();
  if (dot) dot.style.background = active?.color || '#6B7280';
  if (name) name.textContent = active?.name || 'No project';
  if (trigger) trigger.setAttribute('aria-expanded', String(STATE.panelOpen));
}

// ---- switcher panel ----

function renderPanel() {
  const panel = document.getElementById('marginote-switcher-panel');
  if (panel) panel.hidden = !STATE.panelOpen;
  renderProjectList();
}

function renderProjectList() {
  const list = document.getElementById('marginote-project-list');
  if (!list) return;
  list.innerHTML = '';
  for (const project of STATE.projects) {
    list.appendChild(renderProjectRow(project));
  }
}

function renderProjectRow(project) {
  const li = document.createElement('li');
  li.className = 'marginote-project-row';
  li.dataset.projectId = project.id;
  if (project.id === STATE.activeProjectId) li.classList.add('is-active');

  const dot = document.createElement('span');
  dot.className = 'marginote-dot';
  dot.style.background = project.color;
  dot.setAttribute('aria-hidden', 'true');
  li.appendChild(dot);

  if (STATE.renamingId === project.id) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 40;
    input.className = 'marginote-rename-input';
    input.value = project.name;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename(project.id, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelRename();
      }
    });
    input.addEventListener('blur', () => commitRename(project.id, input.value));
    li.appendChild(input);
    // Defer focus to after the element is in the DOM.
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  } else {
    const name = document.createElement('span');
    name.className = 'marginote-project-name';
    name.textContent = project.name;
    li.appendChild(name);

    const check = document.createElement('span');
    check.className = 'marginote-project-check';
    check.textContent = project.id === STATE.activeProjectId ? '✓' : '';
    li.appendChild(check);

    const actions = document.createElement('span');
    actions.className = 'marginote-project-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'marginote-icon-btn';
    renameBtn.dataset.action = 'rename';
    renameBtn.textContent = 'Rename';
    renameBtn.title = 'Rename project';
    actions.appendChild(renameBtn);

    if (project.id !== MARGINOTE_GENERAL_PROJECT_ID) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'marginote-icon-btn';
      deleteBtn.dataset.action = 'delete';
      deleteBtn.textContent = 'Delete';
      deleteBtn.title = 'Delete project';
      actions.appendChild(deleteBtn);
    }

    li.appendChild(actions);

    li.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest('.marginote-project-actions')) return;
      selectProject(project.id);
    });

    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(project.id);
    });

    const deleteBtn = actions.querySelector('[data-action="delete"]');
    deleteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(project);
    });
  }

  return li;
}

// ---- subgroups + recent ----

function renderSubgroupsAndRecent() {
  renderSubgroups();
  renderRecent();
}

function renderSubgroups() {
  const list = document.getElementById('marginote-subgroup-list');
  const form = document.getElementById('marginote-add-subgroup-form');
  if (!list) return;

  if (form) form.hidden = !STATE.addingSubgroup;
  if (STATE.addingSubgroup) {
    const input = /** @type {HTMLInputElement|null} */ (
      document.getElementById('marginote-add-subgroup-input')
    );
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 0);
    }
  }

  list.innerHTML = '';
  if (STATE.subgroups.length === 0 && !STATE.addingSubgroup) {
    const empty = document.createElement('li');
    empty.className = 'marginote-empty';
    empty.textContent = 'No subgroups yet.';
    list.appendChild(empty);
    return;
  }
  for (const sg of STATE.subgroups) {
    const li = document.createElement('li');
    li.className = 'marginote-subgroup-row';

    const name = document.createElement('span');
    name.className = 'marginote-subgroup-name';
    name.textContent = sg.name;
    li.appendChild(name);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'marginote-icon-btn';
    delBtn.dataset.action = 'delete';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => handleDeleteSubgroup(sg));
    li.appendChild(delBtn);

    list.appendChild(li);
  }
}

function renderRecent() {
  const host = document.getElementById('marginote-recent-list');
  if (!host) return;
  host.innerHTML = '';

  if (STATE.recentAnnotations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'marginote-empty';
    empty.textContent = 'No annotations yet.';
    host.appendChild(empty);
    return;
  }

  // Bucket by subgroupId, with null (Ungrouped) first.
  const buckets = new Map();
  buckets.set(null, []);
  for (const sg of STATE.subgroups) buckets.set(sg.id, []);
  for (const a of STATE.recentAnnotations) {
    const key = a.subgroupId ?? null;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(a);
  }

  const subgroupNames = new Map(STATE.subgroups.map((s) => [s.id, s.name]));
  const renderGroup = (label, items) => {
    if (items.length === 0) return;
    const group = document.createElement('div');
    group.className = 'marginote-recent-group';
    const heading = document.createElement('div');
    heading.className = 'marginote-recent-group-heading';
    heading.textContent = label;
    group.appendChild(heading);
    for (const a of items) {
      const item = document.createElement('div');
      item.className = 'marginote-recent-item';
      const text = document.createElement('div');
      text.className = 'marginote-recent-text';
      const snippet = (a.selectedText || '').replace(/\s+/g, ' ').trim();
      text.textContent =
        snippet.length > RECENT_TEXT_MAX
          ? snippet.slice(0, RECENT_TEXT_MAX - 1) + '…'
          : snippet;
      item.appendChild(text);
      const title = document.createElement('div');
      title.className = 'marginote-recent-title';
      title.textContent = a.pageTitle || a.pageUrl || 'Unknown page';
      item.appendChild(title);
      group.appendChild(item);
    }
    host.appendChild(group);
  };

  renderGroup('Ungrouped', buckets.get(null) || []);
  for (const sg of STATE.subgroups) {
    renderGroup(
      subgroupNames.get(sg.id) || sg.name,
      buckets.get(sg.id) || [],
    );
  }
}

function startAddSubgroup() {
  STATE.addingSubgroup = true;
  renderSubgroups();
}

function cancelAddSubgroup() {
  STATE.addingSubgroup = false;
  renderSubgroups();
}

async function commitAddSubgroup(rawName) {
  const name = (rawName || '').trim();
  STATE.addingSubgroup = false;
  if (!name) {
    renderSubgroups();
    return;
  }
  if (!STATE.activeProjectId) {
    showToast('No active project', 'error');
    renderSubgroups();
    return;
  }
  try {
    const saved = await saveSubgroup({
      projectId: STATE.activeProjectId,
      name,
    });
    STATE.subgroups = [...STATE.subgroups, saved];
    renderSubgroupsAndRecent();
  } catch (err) {
    console.warn('[marginote] saveSubgroup failed', err);
    showToast('Failed to add subgroup', 'error');
    renderSubgroups();
  }
}

async function handleDeleteSubgroup(subgroup) {
  try {
    const annotations = await getAnnotations({ subgroupId: subgroup.id });
    const count = annotations.length;
    await deleteSubgroup(subgroup.id);
    await loadState();
    renderSubgroupsAndRecent();
    showToast(
      `Subgroup deleted — ${count} ${
        count === 1 ? 'annotation' : 'annotations'
      } now ungrouped`,
    );
  } catch (err) {
    console.warn('[marginote] deleteSubgroup failed', err);
    showToast('Failed to delete subgroup', 'error');
  }
}

// ---- switcher open/close ----

function openPanel() {
  STATE.panelOpen = true;
  renderHeader();
  renderPanel();
}

function closePanel() {
  STATE.panelOpen = false;
  STATE.renamingId = null;
  hideNewProjectForm();
  renderHeader();
  renderPanel();
}

function togglePanel() {
  if (STATE.panelOpen) closePanel();
  else openPanel();
}

// ---- select project ----

async function selectProject(id) {
  if (id === STATE.activeProjectId) {
    closePanel();
    return;
  }
  try {
    await setActiveProjectId(id);
    STATE.activeProjectId = id;
    closePanel();
    // Active project changed — reload its subgroups and recent annotations.
    await loadState();
    renderHeader();
    renderSubgroupsAndRecent();
  } catch (err) {
    showToast('Failed to switch project', 'error');
    console.warn('[marginote] setActiveProjectId failed', err);
  }
}

// ---- rename ----

function startRename(id) {
  STATE.renamingId = id;
  renderProjectList();
}

function cancelRename() {
  STATE.renamingId = null;
  renderProjectList();
}

async function commitRename(id, rawName) {
  const name = (rawName || '').trim();
  const existing = STATE.projects.find((p) => p.id === id);
  if (!existing) {
    STATE.renamingId = null;
    renderProjectList();
    return;
  }
  if (!name || name === existing.name) {
    STATE.renamingId = null;
    renderProjectList();
    return;
  }
  try {
    const saved = await saveProject({ ...existing, name });
    const idx = STATE.projects.findIndex((p) => p.id === id);
    if (idx >= 0) STATE.projects[idx] = saved;
    STATE.renamingId = null;
    renderHeader();
    renderProjectList();
  } catch (err) {
    showToast('Failed to rename project', 'error');
    console.warn('[marginote] rename failed', err);
    STATE.renamingId = null;
    renderProjectList();
  }
}

// ---- new project form ----

function renderSwatches() {
  const container = document.getElementById('marginote-new-swatches');
  if (!container) return;
  container.innerHTML = '';
  for (const color of PALETTE) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'marginote-swatch';
    btn.style.background = color.hex;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', color.name);
    btn.setAttribute(
      'aria-checked',
      String(color.hex === STATE.newProjectColor),
    );
    btn.dataset.color = color.hex;
    btn.addEventListener('click', () => {
      STATE.newProjectColor = color.hex;
      renderSwatches();
    });
    container.appendChild(btn);
  }
}

function showNewProjectForm() {
  const form = document.getElementById('marginote-new-project-form');
  const btn = document.getElementById('marginote-new-project-btn');
  const input = /** @type {HTMLInputElement|null} */ (
    document.getElementById('marginote-new-name')
  );
  if (!form || !btn) return;
  STATE.newProjectColor = PALETTE[0].hex;
  renderSwatches();
  form.hidden = false;
  btn.hidden = true;
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }
}

function hideNewProjectForm() {
  const form = document.getElementById('marginote-new-project-form');
  const btn = document.getElementById('marginote-new-project-btn');
  if (form) form.hidden = true;
  if (btn) btn.hidden = false;
}

async function submitNewProject(event) {
  event.preventDefault();
  const input = /** @type {HTMLInputElement|null} */ (
    document.getElementById('marginote-new-name')
  );
  const name = (input?.value || '').trim();
  if (!name) {
    showToast('Name is required', 'error');
    return;
  }
  try {
    const saved = await saveProject({
      name,
      color: STATE.newProjectColor,
    });
    STATE.projects = [...STATE.projects, saved];
    await setActiveProjectId(saved.id);
    STATE.activeProjectId = saved.id;
    hideNewProjectForm();
    closePanel();
  } catch (err) {
    showToast('Failed to create project', 'error');
    console.warn('[marginote] create project failed', err);
  }
}

// ---- delete modal ----

function openDeleteModal(project) {
  STATE.pendingDelete = { id: project.id, name: project.name };
  const modal = document.getElementById('marginote-delete-modal');
  const main = document.querySelector('.marginote-popup');
  const nameEl = document.getElementById('marginote-delete-name');
  const moveRadio = /** @type {HTMLInputElement|null} */ (
    document.querySelector(
      'input[name="marginote-cascade"][value="moveToGeneral"]',
    )
  );
  if (nameEl) nameEl.textContent = project.name;
  if (moveRadio) moveRadio.checked = true;
  if (modal) modal.hidden = false;
  if (main instanceof HTMLElement) main.hidden = true;
}

function closeDeleteModal() {
  STATE.pendingDelete = null;
  const modal = document.getElementById('marginote-delete-modal');
  const main = document.querySelector('.marginote-popup');
  if (modal) modal.hidden = true;
  if (main instanceof HTMLElement) main.hidden = false;
}

async function confirmDelete() {
  const target = STATE.pendingDelete;
  if (!target) return;
  const selected = /** @type {HTMLInputElement|null} */ (
    document.querySelector('input[name="marginote-cascade"]:checked')
  );
  const cascadeMode = selected?.value === 'delete' ? 'delete' : 'moveToGeneral';
  try {
    await deleteProject(target.id, { cascadeMode });
    closeDeleteModal();
    await loadState();
    renderHeader();
    renderPanel();
    renderSubgroupsAndRecent();
  } catch (err) {
    showToast('Failed to delete project', 'error');
    console.warn('[marginote] delete project failed', err);
  }
}

// ---- events ----

function wireEvents() {
  document
    .getElementById('marginote-switcher-trigger')
    ?.addEventListener('click', togglePanel);

  document
    .getElementById('marginote-new-project-btn')
    ?.addEventListener('click', showNewProjectForm);

  document
    .getElementById('marginote-new-cancel')
    ?.addEventListener('click', hideNewProjectForm);

  document
    .getElementById('marginote-new-project-form')
    ?.addEventListener('submit', submitNewProject);

  document
    .getElementById('marginote-open-dashboard')
    ?.addEventListener('click', async () => {
      try {
        await chrome.tabs.create({ url: DASHBOARD_URL });
        window.close();
      } catch (err) {
        showToast('Could not open dashboard', 'error');
        console.warn('[marginote] open dashboard failed', err);
      }
    });

  document
    .getElementById('marginote-delete-cancel')
    ?.addEventListener('click', closeDeleteModal);

  document
    .getElementById('marginote-delete-confirm')
    ?.addEventListener('click', confirmDelete);

  document
    .querySelector('#marginote-delete-modal .marginote-modal-backdrop')
    ?.addEventListener('click', closeDeleteModal);

  document
    .getElementById('marginote-add-subgroup-btn')
    ?.addEventListener('click', startAddSubgroup);

  const subgroupInput = /** @type {HTMLInputElement|null} */ (
    document.getElementById('marginote-add-subgroup-input')
  );
  // Guard: pressing Enter commits, then re-render removes the input, firing
  // blur → commit would run again without the guard.
  let subgroupCommitDone = false;
  const resetCommitGuard = () => {
    subgroupCommitDone = false;
  };
  subgroupInput?.addEventListener('focus', resetCommitGuard);
  subgroupInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (subgroupCommitDone) return;
      subgroupCommitDone = true;
      commitAddSubgroup(subgroupInput.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      subgroupCommitDone = true;
      cancelAddSubgroup();
    }
  });
  subgroupInput?.addEventListener('blur', () => {
    if (subgroupCommitDone) return;
    subgroupCommitDone = true;
    commitAddSubgroup(subgroupInput.value);
  });
  document
    .getElementById('marginote-add-subgroup-form')
    ?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (subgroupCommitDone) return;
      subgroupCommitDone = true;
      commitAddSubgroup(subgroupInput?.value || '');
    });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('marginote-delete-modal');
    if (modal && !modal.hidden) closeDeleteModal();
    else if (STATE.panelOpen) closePanel();
  });

  // Keep the popup in sync with storage changes made elsewhere
  // (e.g. dashboard or content-script saves).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const watched = [
      'projects',
      'activeProjectId',
      'subgroups',
      'annotations',
    ];
    if (!watched.some((k) => k in changes)) return;
    (async () => {
      try {
        await loadState();
        renderHeader();
        if (STATE.panelOpen) renderPanel();
        renderSubgroupsAndRecent();
      } catch (err) {
        console.warn('[marginote] popup sync failed', err);
      }
    })();
  });
}

// ---- init ----

async function init() {
  try {
    await migrate();
    await loadState();
    // If somehow the store has no active project yet (e.g. first open before
    // onInstalled has run), fall back to General and persist.
    if (!STATE.activeProjectId && STATE.projects.length > 0) {
      const general =
        STATE.projects.find((p) => p.id === MARGINOTE_GENERAL_PROJECT_ID) ||
        STATE.projects[0];
      STATE.activeProjectId = general.id;
      try {
        await setActiveProjectId(general.id);
      } catch {
        // Non-fatal; the next switch will persist.
      }
    }
    renderHeader();
    renderPanel();
    renderSubgroupsAndRecent();
  } catch (err) {
    showToast('Marginote failed to initialize', 'error');
    console.warn('[marginote] popup init failed', err);
  }
  wireEvents();
}

init();
