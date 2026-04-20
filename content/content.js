// Marginote content script (classic script, not an ES module).
//
// Injected at document_idle on all URLs. Owns:
//   - the selection tooltip (inside Shadow DOM on a #marginote-root host)
//   - capturing anchor data (selectedText, contextBefore/After, container
//     selector, textOffset) when the user clicks Save
//   - re-applying saved highlights on load and on SPA mutations (debounced)
//   - arming the background-owned "Delete Marginote annotation" context
//     menu item when the user right-clicks a highlight
//   - unwrapping a highlight span when the background tells it to
//
// All chrome.storage access is routed through the background service
// worker (see background/background.js) — content scripts are classic
// scripts here so they can't import the ES-module storage utility.

(function () {
  'use strict';

  const CONTEXT_CHARS = 30;
  const MAX_SELECTOR_DEPTH = 6;
  const OBSERVER_DEBOUNCE_MS = 300;
  const HIGHLIGHT_ALPHA = 0.35;
  const DEFAULT_PROJECT_COLOR = '#6B7280';

  const STATE = {
    tooltipHost: /** @type {HTMLElement|null} */ (null),
    tooltipShadow: /** @type {ShadowRoot|null} */ (null),
    pendingSelection: /** @type {null | {
      selectedText: string,
      anchorData: object,
      rect: {top:number,left:number,right:number,bottom:number,width:number,height:number},
    }} */ (null),
    observer: /** @type {MutationObserver|null} */ (null),
    observerTimer: /** @type {number|null} */ (null),
    currentUrl: location.href,
    applying: false,
  };

  // ---- chrome.runtime message wrapper ----

  /**
   * Promise wrapper around chrome.runtime.sendMessage.
   * @param {object} msg
   * @returns {Promise<any>}
   */
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(response || { ok: false });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---- color helpers ----

  /**
   * Convert a hex color (#rgb or #rrggbb) to rgba() with the given alpha.
   * @param {string} hex
   * @param {number} alpha
   * @returns {string}
   */
  function hexToRgba(hex, alpha) {
    const raw = (hex || DEFAULT_PROJECT_COLOR).replace('#', '');
    const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    const r = parseInt(full.slice(0, 2), 16) || 0;
    const g = parseInt(full.slice(2, 4), 16) || 0;
    const b = parseInt(full.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ---- anchor building ----

  /**
   * Build a stable-ish CSS selector for a node. Picks the first ancestor
   * with an id; otherwise builds a `tagName:nth-of-type(n)` path up to body
   * with depth capped at MAX_SELECTOR_DEPTH. Returns 'body' as a last resort.
   * @param {Node} node
   * @returns {string}
   */
  function buildSelector(node) {
    let el = node && node.nodeType === 1 ? /** @type {Element} */ (node) : node?.parentElement;
    if (!el) return 'body';
    const parts = [];
    let depth = 0;
    while (el && el !== document.body && el !== document.documentElement && depth < MAX_SELECTOR_DEPTH) {
      if (el.id) {
        parts.unshift('#' + CSS.escape(el.id));
        return parts.join(' > ');
      }
      const tag = el.tagName.toLowerCase();
      let n = 1;
      let sib = el.previousElementSibling;
      while (sib) {
        if (sib.tagName === el.tagName) n++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${n})`);
      el = el.parentElement;
      depth++;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }

  /**
   * Compute the character offset of a Range's start within the given
   * container's flat textContent by walking text nodes in document order.
   * @param {Element} container
   * @param {Range} range
   * @returns {number}
   */
  function textOffsetInContainer(container, range) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) {
        return offset + range.startOffset;
      }
      offset += node.nodeValue.length;
    }
    // startContainer isn't a descendant text node — fall back to 0.
    return 0;
  }

  /**
   * Compute the character offset of a text node within root.textContent.
   * @param {Element} root
   * @param {Node} target
   * @returns {number}
   */
  function textOffsetOfNode(root, target) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (node === target) return offset;
      offset += node.nodeValue.length;
    }
    return 0;
  }

  /**
   * Capture anchor data for a Range.
   *
   * textOffset and the before/after context are computed relative to the
   * live commonAncestor element — NOT re-resolved through `containerSelector`.
   * If the selector is imprecise (a plausible risk on pages without stable
   * ids), re-resolving at capture time would compute offsets against a
   * different subtree than the one the user actually selected in.
   * @param {Range} range
   * @returns {{selectedText:string, anchorData:object}}
   */
  function captureAnchor(range) {
    const selectedText = range.toString();
    const commonAncestor =
      range.commonAncestorContainer.nodeType === 1
        ? /** @type {Element} */ (range.commonAncestorContainer)
        : range.commonAncestorContainer.parentElement || document.body;

    const containerSelector = buildSelector(commonAncestor);
    const textOffset = textOffsetInContainer(commonAncestor, range);
    const containerText = commonAncestor.textContent || '';
    const contextBefore = containerText.slice(Math.max(0, textOffset - CONTEXT_CHARS), textOffset);
    const contextAfter = containerText.slice(
      textOffset + selectedText.length,
      textOffset + selectedText.length + CONTEXT_CHARS,
    );

    return {
      selectedText,
      anchorData: {
        selectedText,
        contextBefore,
        contextAfter,
        containerSelector,
        textOffset,
      },
    };
  }

  // ---- highlight placement ----

  /**
   * Given a root element and a (start, length) into its flat textContent,
   * return a Range covering those characters, or null if out of bounds.
   * @param {Element} root
   * @param {number} start
   * @param {number} length
   * @returns {Range|null}
   */
  function rangeFromFlatOffset(root, start, length) {
    if (length <= 0) return null;
    const end = start + length;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (!startNode && acc + len > start) {
        startNode = node;
        startOffset = start - acc;
      }
      if (startNode && acc + len >= end) {
        endNode = node;
        endOffset = end - acc;
        break;
      }
      acc += len;
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    } catch {
      return null;
    }
    return range;
  }

  /**
   * Fallback: find the annotation's selectedText by searching for
   * `contextBefore + selectedText + contextAfter` across the full document.
   * If that fails, try just the selectedText.
   * @param {{contextBefore:string, selectedText:string, contextAfter:string}} anchor
   * @returns {Range|null}
   */
  function findRangeByContext(anchor) {
    const full = document.body.textContent || '';
    const needle = anchor.contextBefore + anchor.selectedText + anchor.contextAfter;
    let idx = needle ? full.indexOf(needle) : -1;
    if (idx >= 0) {
      return rangeFromFlatOffset(document.body, idx + anchor.contextBefore.length, anchor.selectedText.length);
    }
    if (anchor.selectedText) {
      idx = full.indexOf(anchor.selectedText);
      if (idx >= 0) {
        return rangeFromFlatOffset(document.body, idx, anchor.selectedText.length);
      }
    }
    return null;
  }

  /**
   * Wrap a Range by wrapping each contained text-node slice in its own
   * marginote-highlight span (sharing `data-annotation-id`). We avoid
   * `range.extractContents()` + `insertNode()` because on rich DOM (links,
   * inline tags — e.g., Wikipedia paragraphs) that approach can extract
   * partial elements and re-insert them in structurally surprising places.
   * Per-text-node splitting preserves the host page's element structure.
   *
   * @param {Range} range
   * @param {string} annotationId
   * @param {string} rgbaColor
   */
  function wrapRange(range, annotationId, rgbaColor) {
    const targets = [];
    if (
      range.startContainer === range.endContainer &&
      range.startContainer.nodeType === Node.TEXT_NODE
    ) {
      targets.push({
        node: range.startContainer,
        startOff: range.startOffset,
        endOff: range.endOffset,
      });
    } else {
      const root =
        range.commonAncestorContainer.nodeType === Node.TEXT_NODE
          ? range.commonAncestorContainer.parentNode
          : range.commonAncestorContainer;
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!range.intersectsNode(node)) continue;
        const startOff = node === range.startContainer ? range.startOffset : 0;
        const endOff = node === range.endContainer ? range.endOffset : node.nodeValue.length;
        if (endOff > startOff) targets.push({ node, startOff, endOff });
      }
    }

    for (const t of targets) {
      let textNode = t.node;
      // Split off the tail first so the head reference keeps its position.
      if (t.endOff < textNode.nodeValue.length) {
        textNode.splitText(t.endOff);
      }
      if (t.startOff > 0) {
        textNode = textNode.splitText(t.startOff);
      }
      const parent = textNode.parentNode;
      if (!parent) continue;
      // Skip if somehow we're already inside one of our own highlights.
      if (
        parent.nodeType === 1 &&
        /** @type {Element} */ (parent).classList?.contains('marginote-highlight')
      ) {
        continue;
      }
      const span = document.createElement('span');
      span.className = 'marginote-highlight';
      span.dataset.annotationId = annotationId;
      span.style.backgroundColor = rgbaColor;
      span.style.borderRadius = '2px';
      parent.insertBefore(span, textNode);
      span.appendChild(textNode);
    }
  }

  /**
   * Resolve + apply a single annotation's highlight. Skips if a highlight
   * span for this annotation id already exists.
   * @param {object} annotation
   * @param {Map<string, object>} projectMap
   */
  function applyHighlight(annotation, projectMap) {
    if (!annotation?.id) return;
    if (document.querySelector(`.marginote-highlight[data-annotation-id="${CSS.escape(annotation.id)}"]`)) {
      return;
    }
    const color = hexToRgba(
      projectMap.get(annotation.projectId)?.color || DEFAULT_PROJECT_COLOR,
      HIGHLIGHT_ALPHA,
    );

    const anchor = annotation.anchorData || {};
    const expected = anchor.selectedText || '';
    let range = null;
    if (anchor.containerSelector) {
      try {
        const container = document.querySelector(anchor.containerSelector);
        if (container) {
          range = rangeFromFlatOffset(container, anchor.textOffset || 0, expected.length);
        }
      } catch {
        range = null;
      }
    }
    if (!range || range.toString() !== expected) {
      range = findRangeByContext(anchor);
    }
    if (!range) {
      console.warn('[marginote] could not re-anchor annotation', annotation.id);
      return;
    }
    // Strict guard: only wrap when the resolved range exactly matches the
    // saved selection. Otherwise we could destroy host content by wrapping
    // (and on the old code path, extracting) the wrong range.
    if (range.toString() !== expected) {
      console.warn('[marginote] range text mismatch, skipping wrap', annotation.id);
      return;
    }
    try {
      wrapRange(range, annotation.id, color);
    } catch (err) {
      console.warn('[marginote] wrap failed for', annotation.id, err);
    }
  }

  /**
   * Load all annotations for the current URL and (re-)apply them.
   */
  async function applyAllAnnotations() {
    if (STATE.applying) return;
    STATE.applying = true;
    try {
      const res = await sendMessage({
        type: 'marginote:getAnnotationsForUrl',
        url: location.href,
      });
      if (!res?.ok) return;
      const projectMap = new Map((res.projects || []).map((p) => [p.id, p]));
      const observer = STATE.observer;
      observer?.disconnect();
      try {
        for (const a of res.annotations || []) {
          applyHighlight(a, projectMap);
        }
      } finally {
        if (observer) observer.observe(document.body, { childList: true, subtree: true, characterData: false });
      }
    } catch (err) {
      console.warn('[marginote] applyAllAnnotations failed', err);
    } finally {
      STATE.applying = false;
    }
  }

  /**
   * Unwrap every highlight span for the given annotation id, restoring the
   * original text in place.
   * @param {string} annotationId
   */
  function unwrapHighlight(annotationId) {
    const spans = document.querySelectorAll('.marginote-highlight');
    for (const span of spans) {
      if (span.dataset.annotationId !== annotationId) continue;
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    }
  }

  // ---- tooltip (Shadow DOM) ----

  function ensureTooltipRoot() {
    if (STATE.tooltipHost && document.body.contains(STATE.tooltipHost)) {
      return STATE.tooltipHost;
    }
    const host = document.createElement('div');
    host.id = 'marginote-root';
    host.style.cssText =
      'all: initial; position: absolute; z-index: 2147483647; display: none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .marginote-tooltip {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 12px;
          line-height: 1;
          background: #111827;
          color: #ffffff;
          border-radius: 6px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
          padding: 0;
          display: inline-flex;
          align-items: center;
          height: 32px;
          overflow: hidden;
        }
        .marginote-tooltip-btn {
          appearance: none;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
          padding: 0 12px;
          height: 100%;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .marginote-tooltip-btn:hover { background: #1f2937; }
        .marginote-tooltip-btn:focus { outline: 2px solid #60a5fa; outline-offset: -2px; }
      </style>
      <div class="marginote-tooltip" role="toolbar" aria-label="Marginote">
        <button class="marginote-tooltip-btn" data-action="save" type="button">Save</button>
      </div>
    `;
    // Keep the document selection alive when the user clicks tooltip UI.
    shadow.addEventListener('mousedown', (e) => e.preventDefault());
    shadow.querySelector('[data-action="save"]').addEventListener('click', onSaveClick);
    document.body.appendChild(host);
    STATE.tooltipHost = host;
    STATE.tooltipShadow = shadow;
    return host;
  }

  function showTooltip(rect) {
    const host = ensureTooltipRoot();
    host.style.display = 'block';
    // Anchor just above the selection rect, clamped to the viewport horizontally.
    const gap = 6;
    const top = Math.max(0, rect.top + window.scrollY - 32 - gap);
    const left = Math.max(0, rect.left + window.scrollX);
    host.style.top = top + 'px';
    host.style.left = left + 'px';
  }

  function hideTooltip() {
    if (STATE.tooltipHost) STATE.tooltipHost.style.display = 'none';
    STATE.pendingSelection = null;
  }

  // ---- event handlers ----

  function isInsideTooltip(target) {
    if (!STATE.tooltipHost || !target) return false;
    const path = typeof target.composedPath === 'function' ? target.composedPath() : null;
    if (path && path.includes(STATE.tooltipHost)) return true;
    return STATE.tooltipHost === target || STATE.tooltipHost.contains(target);
  }

  function isSelectionInsideHighlight(range) {
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    return !!(el && el.closest && el.closest('.marginote-highlight'));
  }

  function onMouseUp(event) {
    // Clicks on/inside the tooltip are handled by the tooltip's own listener.
    if (event.composedPath && event.composedPath().some((n) => n === STATE.tooltipHost)) return;

    // Give the browser a tick to finalize the selection.
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const text = sel.toString();
      if (!text || !text.trim()) return;
      const range = sel.getRangeAt(0);
      if (isSelectionInsideHighlight(range)) return;

      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      const { selectedText, anchorData } = captureAnchor(range);
      STATE.pendingSelection = { selectedText, anchorData, rect };
      showTooltip(rect);
    }, 0);
  }

  function onMouseDownCapture(event) {
    if (isInsideTooltip(event.target)) return;
    if (STATE.tooltipHost && STATE.tooltipHost.style.display !== 'none') {
      hideTooltip();
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') hideTooltip();
  }

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString()) {
      // Don't hide if the tooltip isn't even shown; avoids clearing pendingSelection
      // before the save click handler reads it.
      if (STATE.tooltipHost && STATE.tooltipHost.style.display !== 'none') {
        hideTooltip();
      }
    }
  }

  async function onSaveClick(event) {
    event.stopPropagation();
    const pending = STATE.pendingSelection;
    if (!pending) {
      hideTooltip();
      return;
    }
    try {
      const ctx = await sendMessage({ type: 'marginote:getActiveProjectContext' });
      if (!ctx?.ok) throw new Error(ctx?.error || 'failed to fetch active project');
      const activeProjectId = ctx.activeProjectId;
      const project = (ctx.projects || []).find((p) => p.id === activeProjectId);
      const annotation = {
        projectId: activeProjectId,
        subgroupId: null,
        pageUrl: location.href,
        pageTitle: document.title,
        selectedText: pending.selectedText,
        note: null,
        anchorData: pending.anchorData,
      };
      const res = await sendMessage({ type: 'marginote:saveAnnotation', annotation });
      if (!res?.ok) throw new Error(res?.error || 'save failed');
      const saved = res.annotation;
      const color = hexToRgba(project?.color || DEFAULT_PROJECT_COLOR, HIGHLIGHT_ALPHA);
      const observer = STATE.observer;
      observer?.disconnect();
      try {
        applyHighlight(saved, new Map(project ? [[project.id, project]] : []));
      } finally {
        if (observer) {
          observer.observe(document.body, { childList: true, subtree: true, characterData: false });
        }
      }
      hideTooltip();
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      console.warn('[marginote] save failed', err);
      hideTooltip();
    }
  }

  function onContextMenu(event) {
    if (isInsideTooltip(event.target)) return;
    const target = /** @type {Element|null} */ (event.target);
    const highlight = target && target.closest ? target.closest('.marginote-highlight') : null;
    if (highlight && highlight.dataset?.annotationId) {
      sendMessage({
        type: 'marginote:armDeleteMenu',
        annotationId: highlight.dataset.annotationId,
      }).catch((err) => console.warn('[marginote] arm failed', err));
    } else {
      sendMessage({ type: 'marginote:disarmDeleteMenu' }).catch(() => {});
    }
  }

  function onRuntimeMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'marginote:unwrapAnnotation' && msg.annotationId) {
      const observer = STATE.observer;
      observer?.disconnect();
      try {
        unwrapHighlight(msg.annotationId);
      } finally {
        if (observer) {
          observer.observe(document.body, { childList: true, subtree: true, characterData: false });
        }
      }
    }
  }

  // ---- mutation observer (SPA support) ----

  function scheduleReapply() {
    if (STATE.observerTimer !== null) return;
    STATE.observerTimer = window.setTimeout(() => {
      STATE.observerTimer = null;
      if (location.href !== STATE.currentUrl) {
        STATE.currentUrl = location.href;
      }
      applyAllAnnotations();
    }, OBSERVER_DEBOUNCE_MS);
  }

  function startObserver() {
    if (STATE.observer || !document.body) return;
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations that are entirely inside our own UI.
      for (const m of mutations) {
        if (m.target === STATE.tooltipHost) continue;
        if (STATE.tooltipHost && STATE.tooltipHost.contains(m.target)) continue;
        scheduleReapply();
        return;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: false });
    STATE.observer = observer;
  }

  // ---- init ----

  function init() {
    document.addEventListener('mouseup', onMouseUp, false);
    document.addEventListener('mousedown', onMouseDownCapture, true);
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('selectionchange', onSelectionChange, false);
    document.addEventListener('contextmenu', onContextMenu, true);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    // Apply on initial load, then watch for SPA changes.
    applyAllAnnotations();
    startObserver();
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
