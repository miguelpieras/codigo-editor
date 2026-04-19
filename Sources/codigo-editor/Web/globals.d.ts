import type { ITerminalOptions, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

interface FitAddonNamespace {
  FitAddon: new () => FitAddon;
}

interface MessageHandler {
  postMessage(payload: unknown): void;
}

interface WebkitNamespace {
  messageHandlers?: Record<string, MessageHandler | undefined>;
}

declare global {
  interface ReceiveDataMessage {
    index: number;
    payload: string;
  }

  interface ReceivePasteMessage {
    index: number;
    text: string;
  }

  interface PrefillMessage {
    index: number;
  }

  interface AddTabPayload {
    tab?: unknown;
    activeTabIndex?: unknown;
  }

  interface PaneStatusPayload {
    index?: unknown;
    status?: unknown;
  }

  interface PanePromptSubmittedPayload {
    index?: unknown;
  }

  interface UpdatePanePayload {
    index?: unknown;
    title?: unknown;
    workingDirectory?: unknown;
    startupCommand?: unknown;
    kind?: unknown;
    conversationSummary?: unknown;
  }

  interface GitStatusPayload {
    index?: unknown;
    isRepository?: unknown;
    insertions?: unknown;
    deletions?: unknown;
    syncing?: unknown;
    error?: unknown;
  }

  interface GitFileDetailPayload {
    path?: unknown;
    previousPath?: unknown;
    status?: unknown;
    insertions?: unknown;
    deletions?: unknown;
    diff?: unknown;
  }

  interface GitHubActionStatusPayload {
    index?: unknown;
    state?: unknown;
    runId?: unknown;
    workflowName?: unknown;
    displayTitle?: unknown;
    status?: unknown;
    conclusion?: unknown;
    headBranch?: unknown;
    headSha?: unknown;
    htmlURL?: unknown;
    event?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    jobs?: unknown;
    error?: unknown;
  }

  interface RemoveTabPayload {
    id?: unknown;
    index?: unknown;
    activeTabIndex?: unknown;
  }

  interface RemovePanePayload {
    index?: unknown;
    tabId?: unknown;
    tabIndex?: unknown;
  }

  interface AddPanePayload {
    tabId?: unknown;
    tabIndex?: unknown;
    pane?: unknown;
    position?: unknown;
  }

  interface SettingsPayload {
    playIdleChime?: unknown;
    notifyOnIdle?: unknown;
    terminalCommands?: unknown;
    terminalCommandsByPath?: unknown;
    terminalLinksByPath?: unknown;
    paneCommandSelections?: unknown;
    paneLinkSelections?: unknown;
    terminalCloudAction?: unknown;
    terminalEditorAction?: unknown;
    terminalEditorCommand?: unknown;
    terminalCloudCustomScript?: unknown;
    conversationSummarySource?: unknown;
    conversationSummaryCommand?: unknown;
    githubAccountConnected?: unknown;
  }

  interface Window {
    Terminal?: new (options?: ITerminalOptions) => Terminal;
    FitAddon?: FitAddonNamespace;
    webkit?: WebkitNamespace;
    addCodigoTab?: (payload: AddTabPayload) => void;
    addCodigoPane?: (payload: AddPanePayload) => void;
    removeCodigoTab?: (payload: unknown) => void;
    removeCodigoPane?: (payload: unknown) => void;
    initializeCodigoEditor?: (payload: unknown) => void;
    updatePaneStatus?: (payload: PaneStatusPayload) => void;
    notePanePromptSubmitted?: (payload: PanePromptSubmittedPayload | null | undefined) => void;
    updateGitStatus?: (payload: GitStatusPayload) => void;
    updateGitHubActionStatus?: (payload: GitHubActionStatusPayload | string | null | undefined) => void;
    showGitDetails?: (payload: GitDetailsPayload) => void;
    receiveData?: (payload: ReceiveDataMessage) => void;
    receivePaste?: (payload: ReceivePasteMessage) => void;
    prefill?: (payload: PrefillMessage) => void;
    updatePaneConfig?: (payload: UpdatePanePayload) => void;
    updateCodigoSettings?: (payload: SettingsPayload | string | null | undefined) => void;
    updatePreviewNavigation?: (payload: unknown) => void;
    handlePreviewSnapshotResult?: (payload: unknown) => void;
  }
}

export {};
