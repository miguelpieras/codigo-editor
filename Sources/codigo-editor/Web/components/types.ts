export type Terminal = import('@xterm/xterm').Terminal;
export type FitAddon = import('@xterm/addon-fit').FitAddon;

export type ColumnTuple = [number, number, number];
export type ColumnKey = 'primary' | 'stacked' | 'preview';
export type ColumnIndex = 0 | 1 | 2;
export type PaneStatus = 'connecting' | 'connected' | 'disconnected';
export type PaneColumn = 'primary' | 'stacked';
export type PaneKind = 'shell' | 'codex' | 'claude';
export type TabActivityState = 'loading' | 'idle' | 'active';
export type TerminalCloudAction = 'sync' | 'createPullRequest' | 'customScript';
export type TerminalEditorAction = 'cursor' | 'vscode' | 'custom';
export type ConversationSummarySource = 'off' | 'localCommand' | 'terminalTitle';

export interface TerminalTheme {
  foreground: string;
  background: string;
  cursor?: string;
}

export interface PreviewTabState {
  id: string;
  title: string;
  url: string;
}

export interface PaneDescriptor {
  id: string;
  index: number;
  title: string;
  status: PaneStatus;
  workingDirectory: string;
  startupCommand: string;
  kind: PaneKind;
  conversationSummary: string;
  column: PaneColumn;
}

export interface PaneElements {
  container: HTMLDivElement;
  header: HTMLElement;
  title: HTMLSpanElement;
  githubIndicator?: HTMLSpanElement;
  collapseIndicator?: HTMLButtonElement;
  maximizeButton?: HTMLButtonElement;
  gitStatusContainer?: HTMLDivElement;
  gitSummary?: HTMLSpanElement;
  gitAdditionCount?: HTMLSpanElement;
  gitDeletionCount?: HTMLSpanElement;
  gitSyncButton?: HTMLButtonElement;
  gitUndoButton?: HTMLButtonElement;
  openInCursorButton?: HTMLButtonElement;
  openInFinderButton?: HTMLButtonElement;
  terminalContainer: HTMLDivElement;
  placeholder: HTMLDivElement;
  message: HTMLDivElement;
  reconnectButton: HTMLButtonElement;
  commandTrigger?: HTMLButtonElement;
  commandPlayButton?: HTMLButtonElement;
  linkTrigger?: HTMLButtonElement;
  linkOpenButton?: HTMLButtonElement;
  actions: HTMLDivElement;
}

export interface PaneGitStatus {
  isRepository: boolean;
  insertions: number;
  deletions: number;
  changedFiles: number;
  syncing: boolean;
  error?: string;
}

export type GitHubActionState = 'unknown' | 'success' | 'failure' | 'inProgress';

export interface GitHubActionStepSummary {
  name?: string;
  status?: string;
  conclusion?: string;
  number?: number | null;
  log?: string;
}

export interface GitHubActionJobSummary {
  id: number | null;
  name?: string;
  status?: string;
  conclusion?: string;
  htmlURL?: string;
  startedAt?: string;
  completedAt?: string;
  steps: GitHubActionStepSummary[];
}

export interface PaneGitHubActionStatus {
  state: GitHubActionState;
  runId: number | null;
  workflowName?: string;
  displayTitle?: string;
  status?: string;
  conclusion?: string;
  headBranch?: string;
  headSha?: string;
  htmlURL?: string;
  event?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  jobs: GitHubActionJobSummary[];
  error?: string;
}

export interface GitFileDetail {
  path: string;
  previousPath?: string | null;
  status: string;
  insertions: number;
  deletions: number;
  diff: string;
}

export interface PaneState {
  tabIndex: number;
  descriptor: PaneDescriptor;
  elements: PaneElements;
  terminal: Terminal | null;
  status: PaneStatus;
  collapsed: boolean;
  collapseToggleId: number | null;
  gitStatus?: PaneGitStatus;
  githubActionStatus?: PaneGitHubActionStatus;
  lastGitHubActionModalRunId: string | null;
}

export interface TabState {
  id: string;
  title: string;
  panes: PaneDescriptor[];
  previewTabs: PreviewTabState[];
  activePreviewTabId: string | null;
  activity: TabActivityState;
}

export interface AppSettingsState {
  playIdleChime: boolean;
  notifyOnIdle: boolean;
  terminalCommandsByPath: Record<string, string[]>;
  paneCommandSelections: Record<string, string>;
  terminalLinksByPath: Record<string, string[]>;
  paneLinkSelections: Record<string, string>;
  terminalCloudAction: TerminalCloudAction;
  terminalEditorAction: TerminalEditorAction;
  terminalEditorCommand: string;
  terminalCloudCustomScript: string;
  conversationSummarySource: ConversationSummarySource;
  conversationSummaryCommand: string;
  githubAccountConnected: boolean;
}

export interface PreviewState {
  frames: Map<string, HTMLIFrameElement>;
  urls: Map<string, string>;
  activePreviewTabId: string | null;
  navigation: {
    canGoBack: boolean;
    canGoForward: boolean;
  };
}

export interface ColumnDragState {
  handleIndex: 0 | 1;
  leftIndex: ColumnIndex;
  rightIndex: ColumnIndex;
  pointerId: number;
  startX: number;
  startWidths: ColumnTuple;
  available: number;
}

export interface ColumnHandleTarget {
  left: ColumnIndex;
  right: ColumnIndex;
}

export interface ColumnLayout {
  ratios: ColumnTuple | null;
  currentWidths: ColumnTuple | null;
  minWidths: ColumnTuple;
  dividerWidth: number;
  drag: ColumnDragState | null;
  visibility: Record<ColumnKey, boolean>;
  hiddenWidths: [number | null, number | null, number | null];
  handles: HTMLDivElement[];
  handleTargets: [ColumnHandleTarget | null, ColumnHandleTarget | null];
  availableWidth?: number;
  horizontalPadding: number;
}

export interface TabColumnLayoutState {
  ratios: ColumnTuple | null;
  visibility: Record<ColumnKey, boolean>;
  hiddenWidths: [number | null, number | null, number | null];
}

export interface PaneLayoutColumnState {
  ratios: Record<string, number>;
}

export interface TabPaneLayoutState {
  primary: PaneLayoutColumnState;
  stacked: PaneLayoutColumnState;
}

export interface AppState {
  tabs: TabState[];
  activeTabIndex: number;
  panes: Map<number, PaneState>;
  terminals: Map<number, Terminal>;
  fitAddons: Map<number, FitAddon>;
  pendingPayloads: Map<number, string>;
  pendingGitStatuses: Map<number, PaneGitStatus>;
  pendingGitHubActionStatuses: Map<number, PaneGitHubActionStatus>;
  scheduledFits: Map<number, boolean>;
  draggingTabId: string | null;
  columnLayout: ColumnLayout;
  columnLayoutByTab: Map<string, TabColumnLayoutState>;
  paneLayoutsByTab: Map<string, TabPaneLayoutState>;
  preview: PreviewState;
  maximizedPaneByTab: Map<string, Partial<Record<PaneColumn, number>>>;
  focusedPrimaryPaneByTab: Map<string, number>;
  unreadPrimaryOutputByPane: Map<number, number>;
  promptArmedPrimaryPanes: Set<number>;
  decoders: Map<number, TextDecoder>;
  settings: AppSettingsState;
  terminalTheme: TerminalTheme;
  oscHandlers: Map<number, (() => void)[]>;
}
