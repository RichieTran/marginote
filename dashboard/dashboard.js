import {
  migrate,
  getProjects,
  saveProject,
  deleteProject,
  getAnnotations,
  deleteAnnotation,
  getSubgroups,
  saveSubgroup,
  deleteSubgroup,
  MARGINOTE_GENERAL_PROJECT_ID,
} from '../utils/storage.js';

// Curated Notion-inspired palette (mirrors popup/popup.js).
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

/**
 * Which project currently has its "add group" inline input open.
 * Only one at a time — clicking "+ group" on another project closes this.
 * @type {string|null}
 */
let addingGroupForProjectId = null;

/** @type {string} */
let newProjectColor = PALETTE[0].hex;
/** @type {{id:string,name:string}|null} */
let pendingProjectDelete = null;

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
 * Render the project sidebar with subgroups + per-project "Add group" and
 * per-subgroup "Delete" controls.
 * @param {Array} projects
 * @param {Map<string, Array>} subgroupsByProject
 */
function renderSidebar(projects, subgroupsByProject) {
  const host = document.getElementById('marginote-dashboard-projects');
  if (!host) return;
  host.innerHTML = '';
  for (const project of projects) {
    host.appendChild(renderProjectBlock(project, subgroupsByProject.get(project.id) || []));
  }
}

/**
 * Render one project + its subgroups as a sidebar block.
 * @param {object} project
 * @param {Array} subgroups
 */
function renderProjectBlock(project, subgroups) {
  const block = document.createElement('div');
  block.className = 'marginote-dashboard-project-block';

  const row = document.createElement('div');
  row.className = 'marginote-dashboard-project-row';

  const swatch = document.createElement('span');
  swatch.className = 'marginote-dashboard-project-swatch';
  swatch.style.backgroundColor = project.color || '#6B7280';
  row.appendChild(swatch);

  const name = document.createElement('span');
  name.className = 'marginote-dashboard-project-name';
  name.textContent = project.name;
  row.appendChild(name);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'marginote-dashboard-icon-btn';
  addBtn.textContent = '+ group';
  addBtn.title = 'Add a group to this project';
  addBtn.addEventListener('click', () => {
    addingGroupForProjectId =
      addingGroupForProjectId === project.id ? null : project.id;
    refresh();
  });
  row.appendChild(addBtn);

  if (project.id !== MARGINOTE_GENERAL_PROJECT_ID) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className =
      'marginote-dashboard-icon-btn marginote-dashboard-icon-btn-danger';
    delBtn.textContent = 'Delete';
    delBtn.title = 'Delete this project';
    delBtn.addEventListener('click', () => openProjectDeleteModal(project));
    row.appendChild(delBtn);
  }

  block.appendChild(row);

  const list = document.createElement('ul');
  list.className = 'marginote-dashboard-subgroups';

  for (const sg of subgroups) {
    list.appendChild(renderSubgroupRow(sg));
  }

  if (addingGroupForProjectId === project.id) {
    list.appendChild(renderAddGroupRow(project.id));
  }

  if (list.children.length > 0) block.appendChild(list);

  return block;
}

/**
 * Render a single subgroup row with a Delete button.
 * @param {object} subgroup
 */
function renderSubgroupRow(subgroup) {
  const li = document.createElement('li');
  li.className = 'marginote-dashboard-subgroup-row';

  const name = document.createElement('span');
  name.className = 'marginote-dashboard-subgroup-name';
  name.textContent = subgroup.name;
  li.appendChild(name);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'marginote-dashboard-icon-btn marginote-dashboard-icon-btn-danger';
  delBtn.textContent = 'Delete';
  delBtn.title = 'Delete this group (annotations stay in the project, ungrouped)';
  delBtn.addEventListener('click', async () => {
    const ok = window.confirm(
      `Delete group "${subgroup.name}"? Its annotations will stay in the project, ungrouped.`,
    );
    if (!ok) return;
    try {
      await deleteSubgroup(subgroup.id);
      showToast('Group deleted');
      await refresh();
    } catch (err) {
      console.warn('[marginote] deleteSubgroup failed', err);
      showToast('Failed to delete group', 'error');
    }
  });
  li.appendChild(delBtn);

  return li;
}

/**
 * Render the inline "new group" input row under a project.
 * @param {string} projectId
 */
function renderAddGroupRow(projectId) {
  const li = document.createElement('li');
  li.className = 'marginote-dashboard-subgroup-row marginote-dashboard-subgroup-add';

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = 'Group name';
  input.className = 'marginote-dashboard-subgroup-input';
  input.autocomplete = 'off';

  // Enter fires commit(), which refresh()es the sidebar. That re-render
  // removes this input from the DOM, which fires blur → commit() again,
  // double-saving the subgroup. Guard with a once-flag.
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    addingGroupForProjectId = null;
    if (!name) {
      refresh();
      return;
    }
    try {
      await saveSubgroup({ projectId, name });
      showToast('Group added');
      await refresh();
    } catch (err) {
      console.warn('[marginote] saveSubgroup failed', err);
      showToast('Failed to add group', 'error');
      refresh();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done = true;
      addingGroupForProjectId = null;
      refresh();
    }
  });
  input.addEventListener('blur', commit);

  li.appendChild(input);
  setTimeout(() => input.focus(), 0);
  return li;
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
  const subgroupLists = await Promise.all(
    projects.map((p) => getSubgroups(p.id)),
  );
  const subgroupsByProject = new Map(
    projects.map((p, i) => [p.id, subgroupLists[i]]),
  );
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  renderSidebar(projects, subgroupsByProject);
  renderAnnotations(annotations, projectMap);
}

// ---- new project form ----

function renderNewProjectSwatches() {
  const host = document.getElementById('marginote-dashboard-new-project-swatches');
  if (!host) return;
  host.innerHTML = '';
  for (const color of PALETTE) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'marginote-dashboard-swatch';
    btn.style.background = color.hex;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', color.name);
    btn.setAttribute(
      'aria-checked',
      String(color.hex === newProjectColor),
    );
    btn.addEventListener('click', () => {
      newProjectColor = color.hex;
      renderNewProjectSwatches();
    });
    host.appendChild(btn);
  }
}

function showNewProjectForm() {
  const form = document.getElementById('marginote-dashboard-new-project-form');
  const input = /** @type {HTMLInputElement|null} */ (
    document.getElementById('marginote-dashboard-new-project-name')
  );
  if (!form) return;
  newProjectColor = PALETTE[0].hex;
  renderNewProjectSwatches();
  form.hidden = false;
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }
}

function hideNewProjectForm() {
  const form = document.getElementById('marginote-dashboard-new-project-form');
  if (form) form.hidden = true;
}

async function submitNewProject(event) {
  event.preventDefault();
  const input = /** @type {HTMLInputElement|null} */ (
    document.getElementById('marginote-dashboard-new-project-name')
  );
  const name = (input?.value || '').trim();
  if (!name) {
    showToast('Name is required', 'error');
    return;
  }
  try {
    await saveProject({ name, color: newProjectColor });
    showToast('Project created');
    hideNewProjectForm();
    await refresh();
  } catch (err) {
    console.warn('[marginote] saveProject failed', err);
    showToast('Failed to create project', 'error');
  }
}

// ---- delete project modal ----

function openProjectDeleteModal(project) {
  pendingProjectDelete = { id: project.id, name: project.name };
  const modal = document.getElementById('marginote-dashboard-delete-modal');
  const nameEl = document.getElementById('marginote-dashboard-delete-name');
  const moveRadio = /** @type {HTMLInputElement|null} */ (
    document.querySelector(
      'input[name="marginote-dashboard-cascade"][value="moveToGeneral"]',
    )
  );
  if (nameEl) nameEl.textContent = project.name;
  if (moveRadio) moveRadio.checked = true;
  if (modal) modal.hidden = false;
}

function closeProjectDeleteModal() {
  pendingProjectDelete = null;
  const modal = document.getElementById('marginote-dashboard-delete-modal');
  if (modal) modal.hidden = true;
}

async function confirmProjectDelete() {
  const target = pendingProjectDelete;
  if (!target) return;
  const selected = /** @type {HTMLInputElement|null} */ (
    document.querySelector(
      'input[name="marginote-dashboard-cascade"]:checked',
    )
  );
  const cascadeMode = selected?.value === 'delete' ? 'delete' : 'moveToGeneral';
  try {
    await deleteProject(target.id, { cascadeMode });
    showToast('Project deleted');
    closeProjectDeleteModal();
    await refresh();
  } catch (err) {
    console.warn('[marginote] deleteProject failed', err);
    showToast('Failed to delete project', 'error');
  }
}

function wireProjectControls() {
  document
    .getElementById('marginote-dashboard-new-project-btn')
    ?.addEventListener('click', showNewProjectForm);
  document
    .getElementById('marginote-dashboard-new-project-cancel')
    ?.addEventListener('click', hideNewProjectForm);
  document
    .getElementById('marginote-dashboard-new-project-form')
    ?.addEventListener('submit', submitNewProject);
  document
    .getElementById('marginote-dashboard-delete-cancel')
    ?.addEventListener('click', closeProjectDeleteModal);
  document
    .getElementById('marginote-dashboard-delete-confirm')
    ?.addEventListener('click', confirmProjectDelete);
  document
    .querySelector(
      '#marginote-dashboard-delete-modal .marginote-dashboard-modal-backdrop',
    )
    ?.addEventListener('click', closeProjectDeleteModal);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('marginote-dashboard-delete-modal');
    if (modal && !modal.hidden) closeProjectDeleteModal();
  });
}

async function init() {
  try {
    await migrate();
    wireProjectControls();
    await refresh();
  } catch (err) {
    showToast('Marginote failed to initialize', 'error');
    console.warn('[marginote] dashboard init failed', err);
  }
}

init();
