import { postLog } from './nativeBridge.js';
import { state, PANE_LAYOUT_STORAGE_KEY } from './state.js';
import type { PaneColumn, TabPaneLayoutState } from './types.js';

const PANE_COLUMNS: PaneColumn[] = ['primary', 'stacked'];

function defaultPaneLayout(): TabPaneLayoutState {
  return {
    primary: { ratios: {} },
    stacked: { ratios: {} },
  };
}

function storageKey(tabId: string): string {
  return `${PANE_LAYOUT_STORAGE_KEY}.${tabId}`;
}

function readPaneLayout(tabId: string): TabPaneLayoutState | null {
  try {
    const raw = localStorage.getItem(storageKey(tabId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const layout = defaultPaneLayout();
    PANE_COLUMNS.forEach((column) => {
      const columnData = (parsed as Record<string, unknown>)[column];
      if (!columnData || typeof columnData !== 'object') {
        return;
      }
      const ratios = (columnData as { ratios?: unknown }).ratios;
      if (!ratios || typeof ratios !== 'object') {
        return;
      }
      Object.entries(ratios as Record<string, unknown>).forEach(([key, value]) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
          layout[column].ratios[key] = numeric;
        }
      });
    });
    return layout;
  } catch (error) {
    postLog({ type: 'pane-layout-read-error', error: String(error), tabId });
    return null;
  }
}

function persistPaneLayout(tabId: string, layout: TabPaneLayoutState): void {
  try {
    const payload = {
      primary: { ratios: { ...layout.primary.ratios } },
      stacked: { ratios: { ...layout.stacked.ratios } },
    };
    localStorage.setItem(storageKey(tabId), JSON.stringify(payload));
  } catch (error) {
    postLog({ type: 'pane-layout-write-error', error: String(error), tabId });
  }
}

function ensurePaneLayout(tabId: string): TabPaneLayoutState {
  let layout = state.paneLayoutsByTab.get(tabId) ?? null;
  if (!layout) {
    const stored = readPaneLayout(tabId);
    layout = stored ? stored : defaultPaneLayout();
    state.paneLayoutsByTab.set(tabId, layout);
  }
  return layout;
}

export function getPaneRatios(tabId: string, column: PaneColumn, paneIndices: number[]): number[] {
  if (!tabId || paneIndices.length === 0) {
    return [];
  }
  const layout = ensurePaneLayout(tabId);
  const store = layout[column].ratios;
  const ratios = paneIndices.map((index) => {
    const key = String(index);
    const numeric = Number(store[key]);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
  });
  const total = ratios.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    const fallback = paneIndices.length > 0 ? 1 / paneIndices.length : 0;
    return paneIndices.map(() => fallback);
  }
  return ratios.map((value) => value / total);
}

export function setPaneRatios(
  tabId: string,
  column: PaneColumn,
  paneIndices: number[],
  ratios: number[],
): void {
  if (!tabId || paneIndices.length === 0) {
    return;
  }
  const layout = ensurePaneLayout(tabId);
  const sanitized: number[] = [];
  let total = 0;
  paneIndices.forEach((index, idx) => {
    const value = Number(ratios[idx]);
    const safe = Number.isFinite(value) && value > 0 ? value : 0;
    sanitized.push(safe);
    total += safe;
  });
  if (!Number.isFinite(total) || total <= 0) {
    const fallback = paneIndices.length > 0 ? 1 / paneIndices.length : 0;
    sanitized.fill(fallback);
    total = sanitized.reduce((sum, value) => sum + value, 0);
  }
  const normalised = sanitized.map((value) => value / total);
  const next: Record<string, number> = {};
  paneIndices.forEach((index, idx) => {
    next[String(index)] = normalised[idx] ?? 0;
  });
  layout[column].ratios = next;
  persistPaneLayout(tabId, layout);
}

export function removePaneFromLayout(tabId: string, paneIndex: number): void {
  if (!tabId) {
    return;
  }
  const layout = ensurePaneLayout(tabId);
  let changed = false;
  PANE_COLUMNS.forEach((column) => {
    const store = layout[column].ratios;
    const key = String(paneIndex);
    if (key in store) {
      delete store[key];
      changed = true;
    }
  });
  if (changed) {
    persistPaneLayout(tabId, layout);
  }
}

export function clearPaneLayout(tabId: string): void {
  state.paneLayoutsByTab.delete(tabId);
  try {
    localStorage.removeItem(storageKey(tabId));
  } catch (error) {
    postLog({ type: 'pane-layout-remove-error', error: String(error), tabId });
  }
}

export function prunePaneLayout(tabId: string, column: PaneColumn, validIndices: number[]): void {
  if (!tabId) {
    return;
  }
  const layout = ensurePaneLayout(tabId);
  const store = layout[column].ratios;
  const validKeys = new Set(validIndices.map((index) => String(index)));
  let changed = false;
  Object.keys(store).forEach((key) => {
    if (!validKeys.has(key)) {
      delete store[key];
      changed = true;
    }
  });
  if (changed) {
    persistPaneLayout(tabId, layout);
  }
}
