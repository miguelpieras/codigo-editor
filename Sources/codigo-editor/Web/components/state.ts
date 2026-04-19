import type { AppState, ColumnKey, ColumnTuple } from './types.js';

export const COLUMN_KEYS: ColumnKey[] = ['primary', 'stacked', 'preview'];
export const COLUMN_LAYOUT_STORAGE_KEY = 'codigo-editor.column-layout';
export const DEFAULT_COLUMN_RATIOS: ColumnTuple = [0.3, 0.32, 0.38];
export const PANE_LAYOUT_STORAGE_KEY = 'codigo-editor.pane-layout';

export const state: AppState = {
  tabs: [],
  activeTabIndex: 0,
  panes: new Map(),
  terminals: new Map(),
  fitAddons: new Map(),
  pendingPayloads: new Map(),
  pendingGitStatuses: new Map(),
  pendingGitHubActionStatuses: new Map(),
  scheduledFits: new Map(),
  draggingTabId: null,
  columnLayout: {
    ratios: null,
    currentWidths: null,
    minWidths: [280, 320, 360],
    dividerWidth: 8,
    drag: null,
    visibility: {
      primary: true,
      stacked: true,
      preview: true,
    },
    hiddenWidths: [null, null, null],
    handles: [],
    handleTargets: [null, null],
    availableWidth: undefined,
    horizontalPadding: 0,
  },
  columnLayoutByTab: new Map(),
  paneLayoutsByTab: new Map(),
  preview: {
    frames: new Map(),
    urls: new Map(),
    activePreviewTabId: null,
    navigation: {
      canGoBack: false,
      canGoForward: false,
    },
  },
  maximizedPaneByTab: new Map(),
  focusedPrimaryPaneByTab: new Map(),
  unreadPrimaryOutputByPane: new Map(),
  promptArmedPrimaryPanes: new Set(),
  decoders: new Map(),
  settings: {
    playIdleChime: true,
    notifyOnIdle: false,
    terminalCommandsByPath: {},
    paneCommandSelections: {},
    terminalLinksByPath: {},
    paneLinkSelections: {},
    terminalCloudAction: 'sync',
    terminalEditorAction: 'cursor',
    terminalEditorCommand: '',
    terminalCloudCustomScript: '',
    conversationSummarySource: 'off',
    conversationSummaryCommand: '',
    githubAccountConnected: false,
  },
  terminalTheme: {
    foreground: '#d4d4d4',
    background: '#1e1e1e',
    cursor: '#d4d4d4',
  },
  oscHandlers: new Map(),
};
