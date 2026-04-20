/**
 * Marginote storage utility.
 *
 * Wraps chrome.storage.local behind a narrow async API. All writes and reads
 * are wrapped in try/catch; errors bubble up to callers (the popup/dashboard
 * surface them as non-blocking toasts; the content script logs console.warn).
 *
 * Storage layout
 * --------------
 * {
 *   schemaVersion: 1,
 *   projects: Project[],
 *   subgroups: Subgroup[],
 *   annotations: Annotation[],
 *   activeProjectId: string | null
 * }
 *
 * Schemas (schemaVersion: 1)
 * --------------------------
 * Project:
 *   id: string (uuid)
 *   name: string
 *   color: string (hex, from curated palette — see Prompt 3)
 *   createdAt: ISO timestamp
 *   // Note: subgroups are stored as their own collection keyed by projectId,
 *   // not nested inside the project, to keep reads/writes atomic.
 *
 * Subgroup:
 *   id: string (uuid)
 *   projectId: string
 *   name: string
 *   createdAt: ISO timestamp
 *
 * Annotation:
 *   id: string (uuid)
 *   projectId: string
 *   subgroupId: string | null
 *   pageUrl: string
 *   pageTitle: string
 *   selectedText: string
 *   note: string | null            // added in Prompt 6, migrate() defaults to null
 *   anchorData: {
 *     selectedText: string,
 *     contextBefore: string,        // 30 chars before selection
 *     contextAfter: string,         // 30 chars after selection
 *     containerSelector: string,    // see Prompt 2 for strategy
 *     textOffset: number            // offset within container's textContent
 *   }
 *   createdAt: ISO timestamp
 */

const CURRENT_SCHEMA_VERSION = 1;

const GENERAL_PROJECT_ID = 'general';
const GENERAL_PROJECT_NAME = 'General';
const GENERAL_PROJECT_COLOR = '#6B7280';

const ROOT_DEFAULTS = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  projects: [],
  subgroups: [],
  annotations: [],
  activeProjectId: null,
});

/**
 * Generate a RFC4122-ish v4 UUID using crypto.randomUUID when available.
 * @returns {string}
 */
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: non-cryptographic but sufficient for local IDs.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Read the entire storage root. Returns defaults for missing keys.
 * @returns {Promise<object>}
 */
async function readRoot() {
  try {
    const result = await chrome.storage.local.get(Object.keys(ROOT_DEFAULTS));
    return { ...ROOT_DEFAULTS, ...result };
  } catch (err) {
    console.warn('[marginote] readRoot failed', err);
    throw err;
  }
}

/**
 * Write a partial patch to the storage root.
 * @param {object} patch
 * @returns {Promise<void>}
 */
async function writeRoot(patch) {
  try {
    await chrome.storage.local.set(patch);
  } catch (err) {
    console.warn('[marginote] writeRoot failed', err);
    throw err;
  }
}

/**
 * Run schema migrations. Safe to call repeatedly. Missing fields on older
 * records are filled with defaults rather than erroring.
 * @returns {Promise<void>}
 */
export async function migrate() {
  try {
    const root = await readRoot();
    const patch = {};

    if (typeof root.schemaVersion !== 'number') {
      patch.schemaVersion = CURRENT_SCHEMA_VERSION;
    }
    if (!Array.isArray(root.projects)) patch.projects = [];
    if (!Array.isArray(root.subgroups)) patch.subgroups = [];
    if (!Array.isArray(root.annotations)) patch.annotations = [];
    if (typeof root.activeProjectId === 'undefined') patch.activeProjectId = null;

    // Per-record defaults for annotations (note is added in Prompt 6).
    const annotations = (patch.annotations || root.annotations).map((a) => ({
      id: a.id,
      projectId: a.projectId,
      subgroupId: a.subgroupId ?? null,
      pageUrl: a.pageUrl ?? '',
      pageTitle: a.pageTitle ?? '',
      selectedText: a.selectedText ?? '',
      note: a.note ?? null,
      anchorData: {
        selectedText: a.anchorData?.selectedText ?? a.selectedText ?? '',
        contextBefore: a.anchorData?.contextBefore ?? '',
        contextAfter: a.anchorData?.contextAfter ?? '',
        containerSelector: a.anchorData?.containerSelector ?? '',
        textOffset: a.anchorData?.textOffset ?? 0,
      },
      createdAt: a.createdAt ?? new Date().toISOString(),
    }));

    const projects = (patch.projects || root.projects).map((p) => ({
      id: p.id,
      name: p.name ?? 'Untitled',
      color: p.color ?? GENERAL_PROJECT_COLOR,
      createdAt: p.createdAt ?? new Date().toISOString(),
    }));

    const subgroups = (patch.subgroups || root.subgroups).map((s) => ({
      id: s.id,
      projectId: s.projectId,
      name: s.name ?? 'Untitled',
      createdAt: s.createdAt ?? new Date().toISOString(),
    }));

    // Ensure the reserved "General" project exists so cascade-to-General works.
    if (!projects.some((p) => p.id === GENERAL_PROJECT_ID)) {
      projects.unshift({
        id: GENERAL_PROJECT_ID,
        name: GENERAL_PROJECT_NAME,
        color: GENERAL_PROJECT_COLOR,
        createdAt: new Date().toISOString(),
      });
    }

    patch.projects = projects;
    patch.subgroups = subgroups;
    patch.annotations = annotations;
    patch.schemaVersion = CURRENT_SCHEMA_VERSION;

    await writeRoot(patch);
  } catch (err) {
    console.warn('[marginote] migrate failed', err);
    throw err;
  }
}

/**
 * List all projects, with "General" first.
 * @returns {Promise<Array>}
 */
export async function getProjects() {
  try {
    const { projects } = await readRoot();
    return [...projects].sort((a, b) => {
      if (a.id === GENERAL_PROJECT_ID) return -1;
      if (b.id === GENERAL_PROJECT_ID) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  } catch (err) {
    console.warn('[marginote] getProjects failed', err);
    throw err;
  }
}

/**
 * Insert or update a project. If `project.id` is omitted, one is generated.
 * @param {Partial<{id:string,name:string,color:string,createdAt:string}>} project
 * @returns {Promise<object>} the saved project
 */
export async function saveProject(project) {
  try {
    const root = await readRoot();
    const next = {
      id: project.id || uuid(),
      name: project.name ?? 'Untitled',
      color: project.color ?? GENERAL_PROJECT_COLOR,
      createdAt: project.createdAt ?? new Date().toISOString(),
    };
    const existingIdx = root.projects.findIndex((p) => p.id === next.id);
    const projects = [...root.projects];
    if (existingIdx >= 0) projects[existingIdx] = next;
    else projects.push(next);
    await writeRoot({ projects });
    return next;
  } catch (err) {
    console.warn('[marginote] saveProject failed', err);
    throw err;
  }
}

/**
 * Delete a project. Cascade is explicit:
 *   - cascadeMode: 'delete'         — delete all its annotations + subgroups
 *   - cascadeMode: 'moveToGeneral'  — reassign annotations to General, delete subgroups
 *
 * The reserved "General" project cannot be deleted.
 *
 * @param {string} projectId
 * @param {{ cascadeMode: 'delete' | 'moveToGeneral' }} opts
 * @returns {Promise<void>}
 */
export async function deleteProject(projectId, opts) {
  try {
    if (projectId === GENERAL_PROJECT_ID) {
      throw new Error('The General project cannot be deleted.');
    }
    const cascadeMode = opts?.cascadeMode ?? 'moveToGeneral';
    if (cascadeMode !== 'delete' && cascadeMode !== 'moveToGeneral') {
      throw new Error(`Unknown cascadeMode: ${cascadeMode}`);
    }
    const root = await readRoot();
    const projects = root.projects.filter((p) => p.id !== projectId);
    const subgroups = root.subgroups.filter((s) => s.projectId !== projectId);

    let annotations;
    if (cascadeMode === 'delete') {
      annotations = root.annotations.filter((a) => a.projectId !== projectId);
    } else {
      annotations = root.annotations.map((a) =>
        a.projectId === projectId
          ? { ...a, projectId: GENERAL_PROJECT_ID, subgroupId: null }
          : a,
      );
    }

    const patch = { projects, subgroups, annotations };
    if (root.activeProjectId === projectId) {
      patch.activeProjectId = GENERAL_PROJECT_ID;
    }
    await writeRoot(patch);
  } catch (err) {
    console.warn('[marginote] deleteProject failed', err);
    throw err;
  }
}

/**
 * List subgroups for a project, oldest first.
 * @param {string} projectId
 * @returns {Promise<Array>}
 */
export async function getSubgroups(projectId) {
  try {
    const { subgroups } = await readRoot();
    return subgroups
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (err) {
    console.warn('[marginote] getSubgroups failed', err);
    throw err;
  }
}

/**
 * Insert or update a subgroup.
 * @param {Partial<{id:string,projectId:string,name:string,createdAt:string}>} subgroup
 * @returns {Promise<object>}
 */
export async function saveSubgroup(subgroup) {
  try {
    if (!subgroup.projectId) throw new Error('saveSubgroup requires projectId');
    const root = await readRoot();
    const next = {
      id: subgroup.id || uuid(),
      projectId: subgroup.projectId,
      name: subgroup.name ?? 'Untitled',
      createdAt: subgroup.createdAt ?? new Date().toISOString(),
    };
    const existingIdx = root.subgroups.findIndex((s) => s.id === next.id);
    const subgroups = [...root.subgroups];
    if (existingIdx >= 0) subgroups[existingIdx] = next;
    else subgroups.push(next);
    await writeRoot({ subgroups });
    return next;
  } catch (err) {
    console.warn('[marginote] saveSubgroup failed', err);
    throw err;
  }
}

/**
 * Delete a subgroup. Annotations in the subgroup become ungrouped (subgroupId
 * set to null) but remain in the same project.
 * @param {string} subgroupId
 * @returns {Promise<void>}
 */
export async function deleteSubgroup(subgroupId) {
  try {
    const root = await readRoot();
    const subgroups = root.subgroups.filter((s) => s.id !== subgroupId);
    const annotations = root.annotations.map((a) =>
      a.subgroupId === subgroupId ? { ...a, subgroupId: null } : a,
    );
    await writeRoot({ subgroups, annotations });
  } catch (err) {
    console.warn('[marginote] deleteSubgroup failed', err);
    throw err;
  }
}

/**
 * List annotations, optionally filtered.
 * @param {{projectId?:string, subgroupId?:string|null, pageUrl?:string}} [filters]
 * @returns {Promise<Array>}
 */
export async function getAnnotations(filters = {}) {
  try {
    const { annotations } = await readRoot();
    return annotations.filter((a) => {
      if (filters.projectId && a.projectId !== filters.projectId) return false;
      if (typeof filters.subgroupId !== 'undefined' && a.subgroupId !== filters.subgroupId) {
        return false;
      }
      if (filters.pageUrl && a.pageUrl !== filters.pageUrl) return false;
      return true;
    });
  } catch (err) {
    console.warn('[marginote] getAnnotations failed', err);
    throw err;
  }
}

/**
 * Insert or update an annotation.
 * @param {object} annotation
 * @returns {Promise<object>}
 */
export async function saveAnnotation(annotation) {
  try {
    if (!annotation.projectId) throw new Error('saveAnnotation requires projectId');
    const root = await readRoot();
    const next = {
      id: annotation.id || uuid(),
      projectId: annotation.projectId,
      subgroupId: annotation.subgroupId ?? null,
      pageUrl: annotation.pageUrl ?? '',
      pageTitle: annotation.pageTitle ?? '',
      selectedText: annotation.selectedText ?? '',
      note: annotation.note ?? null,
      anchorData: {
        selectedText: annotation.anchorData?.selectedText ?? annotation.selectedText ?? '',
        contextBefore: annotation.anchorData?.contextBefore ?? '',
        contextAfter: annotation.anchorData?.contextAfter ?? '',
        containerSelector: annotation.anchorData?.containerSelector ?? '',
        textOffset: annotation.anchorData?.textOffset ?? 0,
      },
      createdAt: annotation.createdAt ?? new Date().toISOString(),
    };
    const existingIdx = root.annotations.findIndex((a) => a.id === next.id);
    const annotations = [...root.annotations];
    if (existingIdx >= 0) annotations[existingIdx] = next;
    else annotations.push(next);
    await writeRoot({ annotations });
    return next;
  } catch (err) {
    console.warn('[marginote] saveAnnotation failed', err);
    throw err;
  }
}

/**
 * Delete an annotation by id.
 * @param {string} annotationId
 * @returns {Promise<void>}
 */
export async function deleteAnnotation(annotationId) {
  try {
    const root = await readRoot();
    const annotations = root.annotations.filter((a) => a.id !== annotationId);
    await writeRoot({ annotations });
  } catch (err) {
    console.warn('[marginote] deleteAnnotation failed', err);
    throw err;
  }
}

/**
 * Get the id of the currently active project.
 * @returns {Promise<string|null>}
 */
export async function getActiveProjectId() {
  try {
    const { activeProjectId } = await readRoot();
    return activeProjectId ?? null;
  } catch (err) {
    console.warn('[marginote] getActiveProjectId failed', err);
    throw err;
  }
}

/**
 * Set the currently active project.
 * @param {string|null} projectId
 * @returns {Promise<void>}
 */
export async function setActiveProjectId(projectId) {
  try {
    await writeRoot({ activeProjectId: projectId ?? null });
  } catch (err) {
    console.warn('[marginote] setActiveProjectId failed', err);
    throw err;
  }
}

export const MARGINOTE_GENERAL_PROJECT_ID = GENERAL_PROJECT_ID;
export const MARGINOTE_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

// Run migrations on module load. Callers can await `migrate()` again safely.
migrate().catch((err) => {
  console.warn('[marginote] initial migrate failed', err);
});
