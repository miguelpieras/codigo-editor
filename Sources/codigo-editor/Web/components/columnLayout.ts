import { state, COLUMN_KEYS, COLUMN_LAYOUT_STORAGE_KEY, DEFAULT_COLUMN_RATIOS } from './state.js';
import {
  columnToggleButtons,
  grid,
  previewPaneColumn,
  primaryColumn,
  stackedColumn,
} from './dom.js';
import { postLog } from './nativeBridge.js';
import { createIcon } from './icons.js';
import type {
  ColumnHandleTarget,
  ColumnIndex,
  ColumnKey,
  ColumnTuple,
  TabColumnLayoutState,
} from './types.js';
import { handlePreviewColumnVisibilityChange } from './preview.js';

const columnToggleIcons: Record<ColumnKey, 'columnPrimary' | 'columnStacked' | 'columnPreview'> = {
  primary: 'columnPrimary',
  stacked: 'columnStacked',
  preview: 'columnPreview',
};

let requestPaneFit: ((paneIndex: number) => void) | null = null;

export function registerPaneFitScheduler(callback: (paneIndex: number) => void): void {
  requestPaneFit = callback;
}

function defaultColumnVisibility(): Record<ColumnKey, boolean> {
  return {
    primary: true,
    stacked: true,
    preview: true,
  };
}

function cloneHiddenWidths(
  source: [number | null, number | null, number | null],
): [number | null, number | null, number | null] {
  return [...source] as [number | null, number | null, number | null];
}

function cloneRatios(ratios: ColumnTuple | null): ColumnTuple | null {
  if (!Array.isArray(ratios)) {
    return null;
  }
  return [...ratios] as ColumnTuple;
}

function defaultColumnRatios(): ColumnTuple {
  return [...DEFAULT_COLUMN_RATIOS] as ColumnTuple;
}

function storageKeyForTab(tabId: string): string {
  return `${COLUMN_LAYOUT_STORAGE_KEY}.${tabId}`;
}

function readStoredColumnLayout(tabId: string): Partial<TabColumnLayoutState> | null {
  try {
    const raw = localStorage.getItem(storageKeyForTab(tabId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      ratios?: unknown;
      visibility?: unknown;
      hiddenWidths?: unknown;
    };
    let ratios: ColumnTuple | null = null;
    if (Array.isArray(parsed?.ratios) && parsed.ratios.length === 3) {
      const values = parsed.ratios.map((value) => Number(value));
      if (values.every((value) => Number.isFinite(value) && value >= 0)) {
        ratios = [values[0], values[1], values[2]] as ColumnTuple;
      }
    }
    const visibility = defaultColumnVisibility();
    if (parsed?.visibility && typeof parsed.visibility === 'object') {
      COLUMN_KEYS.forEach((key) => {
        const candidate = (parsed.visibility as Record<string, unknown>)[key];
        if (typeof candidate === 'boolean') {
          visibility[key] = candidate;
        }
      });
    }
    const hiddenWidths: [number | null, number | null, number | null] = [null, null, null];
    if (Array.isArray(parsed?.hiddenWidths) && parsed.hiddenWidths.length === 3) {
      parsed.hiddenWidths.forEach((value, index) => {
        const numeric = Number(value);
        hiddenWidths[index as 0 | 1 | 2] = Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      });
    }

    return {
      ratios,
      visibility,
      hiddenWidths,
    };
  } catch (error) {
    postLog({ type: 'column-layout-read-error', error: String(error), tabId });
    return null;
  }
}

function persistColumnLayout(tabId: string, layout: TabColumnLayoutState): void {
  try {
    const payload = {
      ratios: Array.isArray(layout.ratios) ? [...layout.ratios] : null,
      visibility: { ...layout.visibility },
      hiddenWidths: [...layout.hiddenWidths],
    };
    localStorage.setItem(storageKeyForTab(tabId), JSON.stringify(payload));
  } catch (error) {
    postLog({ type: 'column-layout-write-error', error: String(error), tabId });
  }
}

function ensureTabLayoutState(tabId: string): TabColumnLayoutState {
  let layout = state.columnLayoutByTab.get(tabId) ?? null;
  if (!layout) {
    const stored = readStoredColumnLayout(tabId);
    const storedRatios = cloneRatios(stored?.ratios ?? null);
    layout = {
      ratios: storedRatios ?? defaultColumnRatios(),
      visibility: stored?.visibility ? { ...stored.visibility } : defaultColumnVisibility(),
      hiddenWidths: stored?.hiddenWidths
        ? cloneHiddenWidths(stored.hiddenWidths)
        : [null, null, null],
    };
    state.columnLayoutByTab.set(tabId, layout);
  }
  return layout;
}

export function initialiseTabLayout(tabId: string): void {
  if (typeof tabId !== 'string' || !tabId) {
    return;
  }
  ensureTabLayoutState(tabId);
}

export function removeTabLayout(tabId: string): void {
  if (typeof tabId !== 'string' || !tabId) {
    return;
  }
  state.columnLayoutByTab.delete(tabId);
  try {
    localStorage.removeItem(storageKeyForTab(tabId));
  } catch (error) {
    postLog({ type: 'column-layout-remove-error', error: String(error), tabId });
  }
}

export function rememberActiveColumnLayoutState(tabIdOverride?: string | null): void {
  const tabId = typeof tabIdOverride === 'string' && tabIdOverride
    ? tabIdOverride
    : state.tabs[state.activeTabIndex]?.id;
  if (!tabId) {
    return;
  }
  const layout = ensureTabLayoutState(tabId);
  const active = state.columnLayout;
  layout.ratios = cloneRatios(active.ratios);
  layout.visibility = { ...active.visibility };
  layout.hiddenWidths = cloneHiddenWidths(active.hiddenWidths);
  state.columnLayoutByTab.set(tabId, layout);
  persistColumnLayout(tabId, layout);
}

export function applyColumnLayoutForTab(tabId: string | null): void {
  const activeLayout = state.columnLayout;
  const stored = tabId ? ensureTabLayoutState(tabId) : null;
  activeLayout.drag = null;
  activeLayout.currentWidths = null;
  activeLayout.availableWidth = undefined;
  activeLayout.visibility = stored ? { ...stored.visibility } : defaultColumnVisibility();
  activeLayout.hiddenWidths = stored
    ? cloneHiddenWidths(stored.hiddenWidths)
    : [null, null, null];
  const storedRatios = cloneRatios(stored?.ratios ?? null);
  activeLayout.ratios = storedRatios ?? defaultColumnRatios();
  activeLayout.handleTargets = [null, null];

  updateColumnToggleButtons();

  const targetRatios = storedRatios ?? defaultColumnRatios();
  applyColumnLayoutFromRatios(targetRatios);
}

function columnIndexFromKey(column: ColumnKey): ColumnIndex {
  const index = COLUMN_KEYS.indexOf(column);
  if (index === -1) {
    throw new Error(`Unknown column key: ${column}`);
  }
  return index as ColumnIndex;
}

function getColumnElement(index: ColumnIndex): HTMLDivElement | null {
  switch (index) {
    case 0:
      return primaryColumn;
    case 1:
      return stackedColumn;
    case 2:
      return previewPaneColumn;
    default:
      return null;
  }
}

function getVisibleColumnIndices(): ColumnIndex[] {
  const visibility = state.columnLayout.visibility;
  const indices: ColumnIndex[] = [];
  COLUMN_KEYS.forEach((key, index) => {
    if (visibility[key]) {
      indices.push(index as ColumnIndex);
    }
  });
  return indices;
}

function resolveHandleTarget(handleIndex: 0 | 1): ColumnHandleTarget | null {
  const visibility = state.columnLayout.visibility;
  if (handleIndex === 0) {
    if (!visibility.primary) {
      return null;
    }
    if (visibility.stacked) {
      return { left: 0, right: 1 };
    }
    if (visibility.preview) {
      return { left: 0, right: 2 };
    }
    return null;
  }

  if (!visibility.stacked || !visibility.preview) {
    return null;
  }
  return { left: 1, right: 2 };
}

function refreshHandleTargets(): void {
  state.columnLayout.handleTargets = [
    resolveHandleTarget(0),
    resolveHandleTarget(1),
  ] as [ColumnHandleTarget | null, ColumnHandleTarget | null];
}

function measureCurrentColumnWidths(): ColumnTuple {
  if (Array.isArray(state.columnLayout.currentWidths)) {
    return [...state.columnLayout.currentWidths] as ColumnTuple;
  }
  return [
    primaryColumn?.getBoundingClientRect().width ?? state.columnLayout.minWidths[0],
    stackedColumn?.getBoundingClientRect().width ?? state.columnLayout.minWidths[1],
    previewPaneColumn?.getBoundingClientRect().width ?? state.columnLayout.minWidths[2],
  ];
}

function updateColumnToggleButtons(): void {
  const visibleCount = getVisibleColumnIndices().length;
  columnToggleButtons.forEach((button, key) => {
    const isVisible = state.columnLayout.visibility[key];
    button.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
    button.disabled = isVisible && visibleCount <= 1;
  });
}

function updateColumnVisibilityClasses(): void {
  COLUMN_KEYS.forEach((key, index) => {
    const element = getColumnElement(index as ColumnIndex);
    if (!element) {
      return;
    }
    element.classList.toggle('hidden', !state.columnLayout.visibility[key]);
  });
  handlePreviewColumnVisibilityChange(state.columnLayout.visibility.preview);
}

function isHandleEnabled(handleIndex: 0 | 1): boolean {
  return Boolean(state.columnLayout.handleTargets[handleIndex]);
}

function buildGridTemplate(widths: ColumnTuple): string {
  const layout = state.columnLayout;
  const segments: number[] = [];
  if (layout.visibility.primary) {
    segments.push(widths[0]);
  }
  if (isHandleEnabled(0)) {
    segments.push(layout.dividerWidth);
  }
  if (layout.visibility.stacked) {
    segments.push(widths[1]);
  }
  if (isHandleEnabled(1)) {
    segments.push(layout.dividerWidth);
  }
  if (layout.visibility.preview) {
    segments.push(widths[2]);
  }
  if (segments.length === 0) {
    return `${layout.minWidths[0]}px`;
  }
  return segments
    .map((value) => `${Math.max(0, Math.round(Number.isFinite(value) ? value : 0))}px`)
    .join(' ');
}

function updateHandleVisibility(): void {
  const handles = state.columnLayout.handles;
  if (!Array.isArray(handles) || handles.length === 0) {
    return;
  }
  handles.forEach((handle, index) => {
    if (!handle) {
      return;
    }
    const handleIndex = index as 0 | 1;
    const active = isHandleEnabled(handleIndex);
    if (active) {
      handle.classList.remove('hidden');
      handle.setAttribute('aria-hidden', 'false');
      const targets = state.columnLayout.handleTargets[handleIndex];
      if (targets) {
        handle.dataset['resizeLeft'] = String(targets.left);
        handle.dataset['resizeRight'] = String(targets.right);
      } else {
        delete handle.dataset['resizeLeft'];
        delete handle.dataset['resizeRight'];
      }
    } else {
      handle.classList.add('hidden');
      handle.setAttribute('aria-hidden', 'true');
      delete handle.dataset['resizeLeft'];
      delete handle.dataset['resizeRight'];
    }
  });
}

function scheduleAllPaneFits(): void {
  if (!requestPaneFit) {
    return;
  }
  state.panes.forEach((_, paneIndex) => {
    requestPaneFit!(paneIndex);
  });
}

function toggleColumnVisibility(column: ColumnKey): void {
  const index = columnIndexFromKey(column);
  const layout = state.columnLayout;
  const currentlyVisible = layout.visibility[column];
  const visibleIndices = getVisibleColumnIndices();
  if (currentlyVisible && visibleIndices.length <= 1) {
    return;
  }

  layout.visibility[column] = !currentlyVisible;
  const widths = measureCurrentColumnWidths();
  if (layout.visibility[column]) {
    const restored = layout.hiddenWidths[index];
    if (Number.isFinite(restored) && (restored ?? 0) > 0) {
      widths[index] = restored!;
    } else {
      widths[index] = layout.minWidths[index];
    }
  } else {
    layout.hiddenWidths[index] = widths[index] > 0 ? widths[index] : layout.minWidths[index];
    widths[index] = 0;
  }
  applyColumnWidths(widths);
  updateColumnToggleButtons();
  handlePreviewColumnVisibilityChange(layout.visibility.preview);
  rememberActiveColumnLayoutState();
}

export function ensureColumnVisible(column: ColumnKey): void {
  const layout = state.columnLayout;
  if (layout.visibility[column]) {
    return;
  }
  const index = columnIndexFromKey(column);
  layout.visibility[column] = true;
  const widths = measureCurrentColumnWidths();
  const restored = layout.hiddenWidths[index];
  if (Number.isFinite(restored) && (restored ?? 0) > 0) {
    widths[index] = restored!;
  } else {
    widths[index] = layout.minWidths[index];
  }
  applyColumnWidths(widths);
  updateColumnToggleButtons();
  handlePreviewColumnVisibilityChange(layout.visibility.preview);
  rememberActiveColumnLayoutState();
}

columnToggleButtons.forEach((button, key) => {
  const iconName = columnToggleIcons[key];
  if (iconName && !button.querySelector('svg.icon')) {
    const icon = createIcon(iconName);
    if (icon) {
      button.replaceChildren(icon);
    } else {
      button.textContent = '';
    }
  }
  button.addEventListener('click', () => {
    toggleColumnVisibility(key);
  });
});

function getAvailableColumnWidth(): number {
  const layout = state.columnLayout;
  const visibleIndices = getVisibleColumnIndices();
  if (visibleIndices.length === 0) {
    return layout.minWidths[0] ?? 0;
  }
  const handleCount = Math.max(visibleIndices.length - 1, 0);
  const totalDividerWidth = layout.dividerWidth * handleCount;
  const horizontalPadding = Number.isFinite(layout.horizontalPadding)
    ? layout.horizontalPadding
    : 0;
  const contentWidth = Math.max(grid.clientWidth - horizontalPadding, 0);
  const computed = contentWidth - totalDividerWidth;
  let minTotal = 0;
  visibleIndices.forEach((index) => {
    minTotal += layout.minWidths[index];
  });
  return Math.max(computed, minTotal);
}

function normaliseColumnWidths(widths: ColumnTuple, availableOverride?: number): ColumnTuple {
  const layout = state.columnLayout;
  const visibleIndices = getVisibleColumnIndices();
  if (visibleIndices.length === 0) {
    return [0, 0, 0];
  }
  const available = typeof availableOverride === 'number'
    ? availableOverride
    : getAvailableColumnWidth();

  const sanitised = [0, 0, 0] as ColumnTuple;
  visibleIndices.forEach((index) => {
    const candidate = Number.isFinite(widths[index]) ? widths[index] : layout.minWidths[index];
    sanitised[index] = Math.max(layout.minWidths[index], Math.round(candidate));
  });

  let visibleTotal = 0;
  visibleIndices.forEach((index) => {
    visibleTotal += sanitised[index];
  });
  let difference = available - visibleTotal;
  if (difference !== 0) {
    const adjustIndices = [...visibleIndices].sort((a, b) => b - a);
    adjustIndices.forEach((index) => {
      if (difference === 0) {
        return;
      }
      const min = layout.minWidths[index];
      const current = sanitised[index];
      if (difference > 0) {
        sanitised[index] = current + difference;
        difference = 0;
      } else {
        const allowance = current - min;
        if (allowance <= 0) {
          return;
        }
        const reduction = Math.min(allowance, -difference);
        sanitised[index] = current - reduction;
        difference += reduction;
      }
    });
  }

  return sanitised;
}

function calculateColumnRatios(widths: ColumnTuple): ColumnTuple {
  const total = widths[0] + widths[1] + widths[2] || 1;
  return [widths[0] / total, widths[1] / total, widths[2] / total];
}

export function applyColumnWidths(widths: ColumnTuple, availableOverride?: number): void {
  const layout = state.columnLayout;
  const sanitised = normaliseColumnWidths(widths, availableOverride);
  layout.currentWidths = sanitised;
  layout.availableWidth = typeof availableOverride === 'number'
    ? availableOverride
    : getAvailableColumnWidth();
  layout.ratios = calculateColumnRatios(sanitised);
  refreshHandleTargets();
  updateColumnVisibilityClasses();
  updateHandleVisibility();
  grid.style.setProperty('--grid-template', buildGridTemplate(sanitised));
  scheduleAllPaneFits();
}

export function applyColumnLayoutFromRatios(ratios: ColumnTuple, availableOverride?: number): void {
  const visibleIndices = getVisibleColumnIndices();
  if (visibleIndices.length === 0) {
    return;
  }
  const available = typeof availableOverride === 'number'
    ? availableOverride
    : getAvailableColumnWidth();
  const ratiosArray = Array.isArray(ratios) ? ratios : DEFAULT_COLUMN_RATIOS;
  let total = 0;
  visibleIndices.forEach((index) => {
    const value = ratiosArray[index];
    const fallback = DEFAULT_COLUMN_RATIOS[index];
    const contribution = Number.isFinite(value) && value > 0 ? value : fallback;
    total += contribution;
  });
  total = total || 1;
  const candidate = [0, 0, 0] as ColumnTuple;
  visibleIndices.forEach((index) => {
    const value = ratiosArray[index];
    const ratio = Number.isFinite(value) && value > 0 ? value : DEFAULT_COLUMN_RATIOS[index];
    candidate[index] = ratio / total * available;
  });
  applyColumnWidths(candidate, available);
}

function startColumnResize(handleIndex: 0 | 1, event: PointerEvent): void {
  if (!isHandleEnabled(handleIndex)) {
    return;
  }
  const targets = state.columnLayout.handleTargets[handleIndex];
  if (!targets) {
    return;
  }
  const { left: leftIndex, right: rightIndex } = targets;
  const startWidths = measureCurrentColumnWidths();
  state.columnLayout.drag = {
    handleIndex,
    leftIndex,
    rightIndex,
    pointerId: Number.isFinite(event.pointerId) ? event.pointerId : 0,
    startX: event.clientX,
    startWidths,
    available: getAvailableColumnWidth(),
  };
  document.body.classList.add('resizing-columns');
}

function updateColumnResize(event: PointerEvent): void {
  const drag = state.columnLayout.drag;
  if (!drag || (Number.isFinite(event.pointerId) && event.pointerId !== drag.pointerId)) {
    return;
  }
  event.preventDefault();
  const delta = event.clientX - drag.startX;
  const nextWidths: ColumnTuple = [...drag.startWidths] as ColumnTuple;
  const { leftIndex, rightIndex } = drag;
  if (Number.isInteger(leftIndex) && Number.isInteger(rightIndex)) {
    nextWidths[leftIndex] += delta;
    nextWidths[rightIndex] -= delta;
  }
  applyColumnWidths(nextWidths, drag.available);
}

function finishColumnResize(event?: PointerEvent): void {
  const drag = state.columnLayout.drag;
  if (!drag) {
    return;
  }
  if (event && Number.isFinite(event.pointerId) && event.pointerId !== drag.pointerId) {
    return;
  }
  state.columnLayout.drag = null;
  document.body.classList.remove('resizing-columns');
  rememberActiveColumnLayoutState();
}

function handleColumnResizePointerMove(event: PointerEvent): void {
  if (state.columnLayout.drag) {
    updateColumnResize(event);
  }
}

export function handleWindowResizeForColumns(): void {
  if (state.columnLayout.drag) {
    return;
  }
  const ratios = state.columnLayout.ratios ?? DEFAULT_COLUMN_RATIOS;
  applyColumnLayoutFromRatios(ratios);
}

export function initialiseColumnResizing(): void {
  try {
    const divider = Number.parseFloat(getComputedStyle(grid).getPropertyValue('--divider-width'));
    if (Number.isFinite(divider) && divider > 0) {
      state.columnLayout.dividerWidth = divider;
    }
  } catch (error) {
    postLog({ type: 'column-layout-divider-error', error: String(error) });
  }
  try {
    const style = getComputedStyle(grid);
    const paddingLeft = Number.parseFloat(style.paddingLeft);
    const paddingRight = Number.parseFloat(style.paddingRight);
    const horizontalPadding = [paddingLeft, paddingRight]
      .map((value) => (Number.isFinite(value) ? value : 0))
      .reduce((sum, value) => sum + value, 0);
    state.columnLayout.horizontalPadding = horizontalPadding;
  } catch (error) {
    postLog({ type: 'column-layout-padding-error', error: String(error) });
    state.columnLayout.horizontalPadding = 0;
  }
  const handles = Array.from(grid.querySelectorAll<HTMLDivElement>('.column-resize-handle'));
  state.columnLayout.handles = handles;
  applyColumnLayoutFromRatios(DEFAULT_COLUMN_RATIOS);
  updateColumnToggleButtons();
  handles.forEach((handle) => {
    const handleIndex = Number(handle.dataset['handleIndex']);
    if (handleIndex !== 0 && handleIndex !== 1) {
      return;
    }
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      const typedIndex = handleIndex;
      if (!isHandleEnabled(typedIndex)) {
        return;
      }
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      startColumnResize(typedIndex, event);
    });
    handle.addEventListener('pointerup', finishColumnResize);
    handle.addEventListener('pointercancel', finishColumnResize);
    handle.addEventListener('lostpointercapture', finishColumnResize);
  });

  window.addEventListener('pointermove', handleColumnResizePointerMove);
  window.addEventListener('pointerup', finishColumnResize);
  window.addEventListener('pointercancel', finishColumnResize);
}
