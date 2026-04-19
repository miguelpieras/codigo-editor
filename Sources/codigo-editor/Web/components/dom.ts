import type { ColumnKey } from './types.js';

export function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing expected element #${id}`);
  }
  return element as T;
}

export const appRoot = requireElement<HTMLDivElement>('app');
export const tabBarTabs = requireElement<HTMLDivElement>('tab-bar-tabs');
export const syncAllButton = requireElement<HTMLButtonElement>('sync-all-button');
export const undoAllButton = requireElement<HTMLButtonElement>('undo-all-button');
export const primaryAddTerminalButton = requireElement<HTMLButtonElement>('primary-add-terminal');
export const stackedAddTerminalButton = requireElement<HTMLButtonElement>('stacked-add-terminal');
export const stackedNewFolderButton = requireElement<HTMLButtonElement>('stacked-new-folder');
export const columnToggleStrip = requireElement<HTMLDivElement>('column-toggle-strip');

export const columnToggleButtons = new Map<ColumnKey, HTMLButtonElement>([
  ['primary', requireElement<HTMLButtonElement>('column-toggle-primary')],
  ['stacked', requireElement<HTMLButtonElement>('column-toggle-stacked')],
  ['preview', requireElement<HTMLButtonElement>('column-toggle-preview')],
]);

export const grid = requireElement<HTMLDivElement>('grid');
export const primaryColumn = requireElement<HTMLDivElement>('primary-pane-column');
export const stackedColumn = requireElement<HTMLDivElement>('stacked-pane-column');
export const previewPaneColumn = requireElement<HTMLDivElement>('preview-pane-column');
export const previewColumn = requireElement<HTMLDivElement>('preview-column');
export const previewColumnHeader = requireElement<HTMLDivElement>('preview-column-header');
export const previewTabStrip = requireElement<HTMLDivElement>('preview-tab-strip');
export const previewAddTabButton = requireElement<HTMLButtonElement>('preview-add-tab');
export const primaryAgentSwitcher = requireElement<HTMLDivElement>('primary-agent-switcher');
export const primaryPaneContainer = requireElement<HTMLDivElement>('primary-pane-container');
export const stackedPaneContainer = requireElement<HTMLDivElement>('stacked-pane-container');

export const previewInput = requireElement<HTMLInputElement>('preview-url');
export const previewBackButton = requireElement<HTMLButtonElement>('preview-back');
export const previewSnapshotButton = requireElement<HTMLButtonElement>('preview-snapshot');
export const previewGoButton = requireElement<HTMLButtonElement>('preview-go');
export const previewRefreshButton = requireElement<HTMLButtonElement>('preview-refresh');
export const previewOpenExternalButton = requireElement<HTMLButtonElement>('preview-open-external');
export const previewHost = requireElement<HTMLDivElement>('preview-frame-host');
export const aiWorkSummaryElement = requireElement<HTMLDivElement>('ai-work-summary');
export const aiWorkTotalElement = requireElement<HTMLSpanElement>('ai-work-total');
export const emptyState = requireElement<HTMLDivElement>('empty-state');
