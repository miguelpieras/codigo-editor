import { state } from './components/state.js';
import { notifyNativeReady, postLog } from './components/nativeBridge.js';
import {
  registerPreviewControls,
  applyNativePreviewNavigation,
  handlePreviewSnapshotResult,
  handleTerminalPreviewCandidate,
} from './components/preview.js';
import {
  registerPaneFitScheduler,
  initialiseColumnResizing,
  handleWindowResizeForColumns,
  initialiseTabLayout,
} from './components/columnLayout.js';
import {
  createPane,
  setPaneStatus,
  focusFirstTerminal,
  removePaneAt,
  updateVisiblePanes,
  updatePaneGitStatus,
  updatePaneGitHubActionStatus,
  refreshPaneLocationActions,
  refreshPaneCommandControls,
  refreshAllPaneGitStatus,
  notePrimaryPaneOutput,
} from './components/panes.js';
import {
  renderTabBar,
  selectTab,
  removeTabAt,
} from './components/tabs.js';
import {
  ensureTerminal,
  fromBase64,
  scheduleFit,
} from './components/terminals.js';
import { normaliseDirectoryKey, sanitizeCommandList, sanitizeLinkList } from './components/pathUtils.js';
import { notePaneActivity, notePanePromptSubmitted } from './components/tabActivity.js';
import {
  normalisePaneTitle,
  normaliseTabDescriptor,
  normaliseStoredPreviewURL,
  normalisePaneDescriptor,
} from './components/dataTransforms.js';
import { initialiseFromPayload } from './components/appInit.js';
import { whenTerminalReady } from './components/bootstrap.js';
import { initialiseColumnActions, refreshGitHubControls } from './components/columnActions.js';
import { applyGitDetails } from './components/gitDetailsModal.js';
import type { PaneStatus, GitFileDetail, PaneGitHubActionStatus } from './components/types.js';

const LOCAL_PREVIEW_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s'"<>]*)?)/gi;

function extractLocalPreviewUrl(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  LOCAL_PREVIEW_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = LOCAL_PREVIEW_PATTERN.exec(text)) !== null) {
    const candidate = match[1]?.replace(/[),.;]+$/u, '') ?? '';
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

interface GitStatusPayload {
  index?: unknown;
  isRepository?: unknown;
  insertions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
  syncing?: unknown;
  error?: unknown;
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

interface GitStatus {
  isRepository: boolean;
  insertions: number;
  deletions: number;
  changedFiles: number;
  syncing: boolean;
  error?: string;
}

interface GitFileDetailPayload {
  path?: unknown;
  previousPath?: unknown;
  status?: unknown;
  insertions?: unknown;
  deletions?: unknown;
  diff?: unknown;
}

interface GitHubActionStepPayload {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  number?: unknown;
  log?: unknown;
}

interface GitHubActionJobPayload {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  htmlURL?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  steps?: unknown;
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

interface GitDetailsPayload {
  index?: unknown;
  files?: unknown;
  error?: unknown;
}

registerPreviewControls();
registerPaneFitScheduler((paneIndex) => scheduleFit(paneIndex));
initialiseColumnResizing();
initialiseColumnActions();

window.addEventListener('resize', () => {
  handleWindowResizeForColumns();
  state.panes.forEach((_, paneIndex) => {
    scheduleFit(paneIndex);
  });
});

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', notifyNativeReady);
} else {
  notifyNativeReady();
}

window.initializeCodigoEditor = function initializeCodigoEditor(payload: unknown): void {
  try {
    const normalised = (typeof payload === 'string' ? JSON.parse(payload) : (payload ?? {})) as {
      tabs?: unknown;
      activeTabIndex?: unknown;
      settings?: unknown;
    };
    whenTerminalReady(() => initialiseFromPayload(normalised));
  } catch (error) {
    postLog({ type: 'init-error', error: String(error) });
  }
};

function applySettingsPayload(payload: SettingsPayload): void {
  const chime = payload?.playIdleChime;
  if (typeof chime === 'boolean') {
    state.settings.playIdleChime = chime;
  }

  const notify = payload?.notifyOnIdle;
  if (typeof notify === 'boolean') {
    state.settings.notifyOnIdle = notify;
  }

  const commandsByPathPayload = payload?.terminalCommandsByPath;
  const nextCommandsByPath: Record<string, string[]> = {};
  if (commandsByPathPayload && typeof commandsByPathPayload === 'object' && !Array.isArray(commandsByPathPayload)) {
    Object.entries(commandsByPathPayload as Record<string, unknown>).forEach(([rawKey, value]) => {
      const key = normaliseDirectoryKey(rawKey);
      const commands = sanitizeCommandList(value);
      nextCommandsByPath[key] = commands;
    });
  }

  if (
    Object.keys(nextCommandsByPath).length === 0
    && payload?.terminalCommands
    && typeof payload.terminalCommands === 'object'
    && !Array.isArray(payload.terminalCommands)
  ) {
    Object.entries(payload.terminalCommands as Record<string, unknown>).forEach(([rawKey, value]) => {
      const key = normaliseDirectoryKey(rawKey);
      const commands = sanitizeCommandList(value);
      nextCommandsByPath[key] = commands;
    });
  }

  if (Object.keys(nextCommandsByPath).length === 0) {
    const legacy = sanitizeCommandList(payload?.terminalCommands);
    nextCommandsByPath[''] = legacy;
  }

  state.settings.terminalCommandsByPath = Object.fromEntries(
    Object.entries(nextCommandsByPath).map(([key, values]) => [key, [...values]])
  );

  const linksByPathPayload = payload?.terminalLinksByPath;
  const nextLinksByPath: Record<string, string[]> = {};
  if (linksByPathPayload && typeof linksByPathPayload === 'object' && !Array.isArray(linksByPathPayload)) {
    Object.entries(linksByPathPayload as Record<string, unknown>).forEach(([rawKey, value]) => {
      const key = normaliseDirectoryKey(rawKey);
      const links = sanitizeLinkList(value);
      nextLinksByPath[key] = links;
    });
  }

  state.settings.terminalLinksByPath = Object.fromEntries(
    Object.entries(nextLinksByPath).map(([key, values]) => [key, [...values]])
  );

  const resolveCommandsForKey = (key: string): string[] => {
    const commands = state.settings.terminalCommandsByPath[key];
    if (Array.isArray(commands)) {
      return commands;
    }
    const fallback = state.settings.terminalCommandsByPath[''];
    return Array.isArray(fallback) ? fallback : [];
  };

  const resolveLinksForKey = (key: string): string[] => {
    const links = state.settings.terminalLinksByPath[key];
    if (Array.isArray(links)) {
      return links;
    }
    const fallback = state.settings.terminalLinksByPath[''];
    return Array.isArray(fallback) ? fallback : [];
  };

  const selectionsPayload = payload?.paneCommandSelections;
  if (selectionsPayload && typeof selectionsPayload === 'object') {
    const nextSelections: Record<string, string> = {};
    Object.entries(selectionsPayload as Record<string, unknown>).forEach(([key, value]) => {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string' && value.trim().length > 0) {
        nextSelections[key] = value.trim();
      }
    });
    state.settings.paneCommandSelections = nextSelections;
  }

  state.panes.forEach((pane) => {
    const key = normaliseDirectoryKey(pane.descriptor.workingDirectory ?? '');
    const allowed = resolveCommandsForKey(key);
    const paneId = pane.descriptor.id;
    const selection = state.settings.paneCommandSelections[paneId];
    if (typeof selection !== 'string' || !allowed.includes(selection)) {
      delete state.settings.paneCommandSelections[paneId];
    }
  });

  const linkSelectionsPayload = payload?.paneLinkSelections;
  if (linkSelectionsPayload && typeof linkSelectionsPayload === 'object') {
    const nextSelections: Record<string, string> = {};
    Object.entries(linkSelectionsPayload as Record<string, unknown>).forEach(([key, value]) => {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string' && value.trim().length > 0) {
        nextSelections[key] = value.trim();
      }
    });
    state.settings.paneLinkSelections = nextSelections;
  }

  state.panes.forEach((pane) => {
    const key = normaliseDirectoryKey(pane.descriptor.workingDirectory ?? '');
    const allowedLinks = resolveLinksForKey(key);
    const paneId = pane.descriptor.id;
    const selection = state.settings.paneLinkSelections[paneId];
    if (typeof selection !== 'string' || !allowedLinks.includes(selection)) {
      delete state.settings.paneLinkSelections[paneId];
    }
  });

  const actionPayload = payload?.terminalCloudAction;
  if (actionPayload === 'createPullRequest') {
    state.settings.terminalCloudAction = 'createPullRequest';
  } else if (actionPayload === 'customScript') {
    state.settings.terminalCloudAction = 'customScript';
  } else {
    state.settings.terminalCloudAction = 'sync';
  }

  const editorActionPayload = payload?.terminalEditorAction;
  if (editorActionPayload === 'vscode') {
    state.settings.terminalEditorAction = 'vscode';
  } else if (editorActionPayload === 'custom') {
    state.settings.terminalEditorAction = 'custom';
  } else {
    state.settings.terminalEditorAction = 'cursor';
  }

  const editorCommandPayload = payload?.terminalEditorCommand;
  if (typeof editorCommandPayload === 'string') {
    state.settings.terminalEditorCommand = editorCommandPayload.trim();
  } else if (typeof state.settings.terminalEditorCommand !== 'string') {
    state.settings.terminalEditorCommand = '';
  }

  const customScriptPayload = payload?.terminalCloudCustomScript;
  if (typeof customScriptPayload === 'string') {
    state.settings.terminalCloudCustomScript = customScriptPayload.replace(/\r\n/g, '\n');
  } else if (typeof state.settings.terminalCloudCustomScript !== 'string') {
    state.settings.terminalCloudCustomScript = '';
  }

  const summarySourcePayload = payload?.conversationSummarySource;
  if (summarySourcePayload === 'localCommand') {
    state.settings.conversationSummarySource = 'localCommand';
  } else if (summarySourcePayload === 'terminalTitle') {
    state.settings.conversationSummarySource = 'terminalTitle';
  } else {
    state.settings.conversationSummarySource = 'off';
  }

  const summaryCommandPayload = payload?.conversationSummaryCommand;
  if (typeof summaryCommandPayload === 'string') {
    state.settings.conversationSummaryCommand = summaryCommandPayload.trim();
  } else if (typeof state.settings.conversationSummaryCommand !== 'string') {
    state.settings.conversationSummaryCommand = '';
  }

  const connectedPayload = payload?.githubAccountConnected;
  if (typeof connectedPayload === 'boolean') {
    state.settings.githubAccountConnected = connectedPayload;
  }

  refreshPaneCommandControls();
  refreshGitHubControls();
  refreshAllPaneGitStatus();
  updateVisiblePanes();
  state.panes.forEach((pane) => {
    refreshPaneLocationActions(pane);
  });
}

function normaliseGitFileDetail(raw: unknown): GitFileDetail | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const payload = raw as GitFileDetailPayload;
  const path = typeof payload.path === 'string' ? payload.path : null;
  if (!path) {
    return null;
  }

  const diff = typeof payload.diff === 'string' ? payload.diff : '';
  const status = typeof payload.status === 'string' && payload.status.trim().length > 0
    ? payload.status
    : 'modified';

  const insertionsValue = Number(payload.insertions);
  const deletionsValue = Number(payload.deletions);

  const previousPath = typeof payload.previousPath === 'string'
    ? payload.previousPath
    : null;

  return {
    path,
    previousPath,
    status,
    insertions: Number.isFinite(insertionsValue) ? Math.max(0, Math.trunc(insertionsValue)) : 0,
    deletions: Number.isFinite(deletionsValue) ? Math.max(0, Math.trunc(deletionsValue)) : 0,
    diff,
  };
}

window.addCodigoTab = function addCodigoTab(payload: AddTabPayload): void {
  try {
    const tabDescriptor = normaliseTabDescriptor(payload.tab, state.tabs.length);
    if (!tabDescriptor) {
      return;
    }
    const activeTabIndex = Number(payload.activeTabIndex);
    const tabIndex = state.tabs.length;
    const previewTabs = tabDescriptor.previewTabs.map((previewTab, previewIndex) => {
      const url = normaliseStoredPreviewURL(previewTab.url);
      state.preview.urls.set(previewTab.id, url);
      const title = previewTab.title && previewTab.title.trim().length > 0
        ? previewTab.title
        : `Preview ${previewIndex + 1}`;
      return { id: previewTab.id, title, url };
    });
    const activePreviewTabId = tabDescriptor.activePreviewTabId && previewTabs.some((preview) => preview.id === tabDescriptor.activePreviewTabId)
      ? tabDescriptor.activePreviewTabId
      : previewTabs[0]?.id ?? null;

    state.tabs.push({
      id: tabDescriptor.id,
      title: tabDescriptor.title,
      panes: tabDescriptor.panes.map((pane) => ({ ...pane })),
      previewTabs,
      activePreviewTabId,
      activity: 'loading',
    });
    initialiseTabLayout(tabDescriptor.id);
    tabDescriptor.panes.forEach((pane) => {
      createPane(tabIndex, pane);
    });

    renderTabBar();
    const nextIndex = Number.isFinite(activeTabIndex) ? activeTabIndex : tabIndex;
    selectTab(nextIndex, { force: true });
  } catch (error) {
    postLog({ type: 'add-tab-error', error: String(error), payload });
  }
};

window.addCodigoPane = function addCodigoPane(payload: AddPanePayload): void {
  try {
    const tabId = typeof payload?.tabId === 'string' ? payload.tabId : null;
    const tabIndexValue = Number(payload?.tabIndex);
    const panePayload = payload?.pane;
    const positionValue = Number(payload?.position);

    let targetIndex = -1;
    if (Number.isFinite(tabIndexValue) && tabIndexValue >= 0 && tabIndexValue < state.tabs.length) {
      targetIndex = tabIndexValue;
    } else if (tabId) {
      targetIndex = state.tabs.findIndex((tab) => tab.id === tabId);
    }
    if (targetIndex < 0 || targetIndex >= state.tabs.length) {
      return;
    }

    const descriptor = normalisePaneDescriptor(panePayload);
    if (!descriptor) {
      return;
    }

    const tab = state.tabs[targetIndex];
    if (!tab) {
      return;
    }

    let insertionIndex: number;
    if (Number.isFinite(positionValue)) {
      insertionIndex = Math.max(0, Math.min(Number(positionValue), tab.panes.length));
    } else if (descriptor.column === 'primary') {
      const firstStacked = tab.panes.findIndex((pane) => pane.column === 'stacked');
      insertionIndex = firstStacked >= 0 ? firstStacked : tab.panes.length;
    } else {
      insertionIndex = tab.panes.length;
    }

    tab.panes.splice(insertionIndex, 0, { ...descriptor });
    createPane(targetIndex, descriptor);

    if (targetIndex === state.activeTabIndex) {
      updateVisiblePanes();
    }
  } catch (error) {
    postLog({ type: 'add-pane-error', error: String(error), payload });
  }
};

window.updatePreviewNavigation = function updatePreviewNavigation(payload: unknown): void {
  try {
    applyNativePreviewNavigation(payload);
  } catch (error) {
    postLog({ type: 'preview-navigation-error', error: String(error), payload });
  }
};

window.handlePreviewSnapshotResult = function handlePreviewSnapshotResultFromNative(payload: unknown): void {
  try {
    handlePreviewSnapshotResult(payload);
  } catch (error) {
    postLog({ type: 'preview-snapshot-error', error: String(error), payload });
  }
};

window.updateCodigoSettings = function updateCodigoSettings(payload: SettingsPayload | string | null | undefined): void {
  try {
    let data: SettingsPayload | null = null;
    if (typeof payload === 'string') {
      data = JSON.parse(payload) as SettingsPayload;
    } else if (payload && typeof payload === 'object') {
      data = payload;
    }
    if (data) {
      applySettingsPayload(data);
    }
  } catch (error) {
    postLog({ type: 'settings-error', error: String(error) });
  }
};

window.updatePaneStatus = function updatePaneStatus(payload: PaneStatusPayload): void {
  try {
    const index = Number(payload.index);
    const status = typeof payload.status === 'string' ? payload.status as PaneStatus : null;
    if (!Number.isFinite(index) || !status) {
      return;
    }
    if (status !== 'connecting' && status !== 'connected' && status !== 'disconnected') {
      return;
    }
    setPaneStatus(index, status);
  } catch (error) {
    postLog({ type: 'pane-status-error', error: String(error), payload });
  }
};

window.notePanePromptSubmitted = function notePanePromptSubmittedFromNative(payload: { index?: unknown } | null | undefined): void {
  try {
    const index = Number(payload?.index);
    if (!Number.isFinite(index)) {
      return;
    }
    notePanePromptSubmitted(index);
  } catch (error) {
    postLog({ type: 'pane-prompt-submitted-error', error: String(error), payload });
  }
};

window.updateGitStatus = function updateGitStatus(payload: GitStatusPayload): void {
  try {
    const index = Number(payload?.index);
    if (!Number.isFinite(index)) {
      return;
    }
    const insertionsValue = Number(payload?.insertions);
    const deletionsValue = Number(payload?.deletions);
    const changedFilesValue = Number(payload?.changedFiles);
    const status = {
      isRepository: Boolean(payload?.isRepository),
      insertions: Number.isFinite(insertionsValue) ? Math.max(0, insertionsValue) : 0,
      deletions: Number.isFinite(deletionsValue) ? Math.max(0, deletionsValue) : 0,
      changedFiles: Number.isFinite(changedFilesValue) ? Math.max(0, changedFilesValue) : 0,
      syncing: Boolean(payload?.syncing),
      error: typeof payload?.error === 'string' ? payload.error : undefined,
    } satisfies GitStatus;
    updatePaneGitStatus(index, status);
  } catch (error) {
    postLog({ type: 'git-status-error', error: String(error), payload });
  }
};

window.updateGitHubActionStatus = function updateGitHubActionStatus(payload: GitHubActionStatusPayload | string | null | undefined): void {
  try {
    let data: GitHubActionStatusPayload | null = null;
    if (typeof payload === 'string') {
      data = JSON.parse(payload) as GitHubActionStatusPayload;
    } else if (payload && typeof payload === 'object') {
      data = payload;
    }
    if (!data) {
      return;
    }
    const parseNumber = (input: unknown): number | null => {
      if (typeof input === 'number' && Number.isFinite(input)) {
        return input;
      }
      if (typeof input === 'string') {
        const parsed = Number.parseInt(input, 10);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    };
    const index = Number(data.index);
    if (!Number.isFinite(index)) {
      return;
    }
    const jobPayloads = Array.isArray(data.jobs) ? (data.jobs as unknown[]) : [];
    const jobs = jobPayloads.map((candidate) => {
      const job = candidate as GitHubActionJobPayload;
      const stepsPayloads = Array.isArray(job?.steps) ? (job.steps as unknown[]) : [];
      const steps = stepsPayloads.map((stepCandidate) => {
        const step = stepCandidate as GitHubActionStepPayload;
        return {
          name: typeof step?.name === 'string' ? step.name : undefined,
          status: typeof step?.status === 'string' ? step.status : undefined,
          conclusion: typeof step?.conclusion === 'string' ? step.conclusion : undefined,
          number: parseNumber(step?.number),
          log: typeof step?.log === 'string' ? step.log : undefined,
        };
      });
      return {
        id: parseNumber(job?.id),
        name: typeof job?.name === 'string' ? job.name : undefined,
        status: typeof job?.status === 'string' ? job.status : undefined,
        conclusion: typeof job?.conclusion === 'string' ? job.conclusion : undefined,
        htmlURL: typeof job?.htmlURL === 'string' ? job.htmlURL : undefined,
        startedAt: typeof job?.startedAt === 'string' ? job.startedAt : undefined,
        completedAt: typeof job?.completedAt === 'string' ? job.completedAt : undefined,
        steps,
      };
    });
    const rawState = typeof data.state === 'string' ? data.state : 'unknown';
    const status: PaneGitHubActionStatus = {
      state: rawState as PaneGitHubActionStatus['state'],
      runId: parseNumber(data.runId),
      workflowName: typeof data.workflowName === 'string' ? data.workflowName : undefined,
      displayTitle: typeof data.displayTitle === 'string' ? data.displayTitle : undefined,
      status: typeof data.status === 'string' ? data.status : undefined,
      conclusion: typeof data.conclusion === 'string' ? data.conclusion : undefined,
      headBranch: typeof data.headBranch === 'string' ? data.headBranch : undefined,
      headSha: typeof data.headSha === 'string' ? data.headSha : undefined,
      htmlURL: typeof data.htmlURL === 'string' ? data.htmlURL : undefined,
      event: typeof data.event === 'string' ? data.event : undefined,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : undefined,
      completedAt: typeof data.completedAt === 'string' ? data.completedAt : undefined,
      jobs,
      error: typeof data.error === 'string' ? data.error : undefined,
    };
    updatePaneGitHubActionStatus(index, status);
  } catch (error) {
    postLog({ type: 'github-action-status-error', error: String(error), payload });
  }
};

window.showGitDetails = function showGitDetails(payload: GitDetailsPayload): void {
  try {
    const index = Number(payload?.index);
    if (!Number.isFinite(index)) {
      return;
    }

    const fileCandidates = Array.isArray(payload?.files) ? payload.files as unknown[] : [];
    const files: GitFileDetail[] = [];
    fileCandidates.forEach((candidate) => {
      const detail = normaliseGitFileDetail(candidate);
      if (detail) {
        files.push(detail);
      }
    });

    const errorText = typeof payload?.error === 'string' ? payload.error : undefined;
    applyGitDetails(index, files, errorText);
  } catch (error) {
    postLog({ type: 'git-details-error', error: String(error), payload });
  }
};

window.receiveData = function receiveData({ index, payload }: ReceiveDataMessage): void {
  const text = fromBase64(index, payload);
  const terminal = state.terminals.get(index);
  if (terminal) {
    terminal.write(text);
  } else {
    const existing = state.pendingPayloads.get(index) ?? '';
    state.pendingPayloads.set(index, existing + text);
  }
  notePaneActivity(index, text);
  notePrimaryPaneOutput(index, text);

  const previewUrl = extractLocalPreviewUrl(text);
  if (previewUrl) {
    const pane = state.panes.get(index);
    if (pane && pane.descriptor.column === 'stacked') {
      handleTerminalPreviewCandidate(pane.tabIndex, pane.descriptor.index, previewUrl);
    }
  }
};

window.receivePaste = function receivePaste({ index, text }: ReceivePasteMessage): void {
  const terminal = ensureTerminal(index);
  if (terminal && typeof text === 'string' && text.length > 0) {
    if (typeof terminal.paste === 'function') {
      terminal.paste(text);
    } else {
      terminal.write(text);
    }
  }
};

window.prefill = function prefill({ index }: PrefillMessage): void {
  const terminal = ensureTerminal(index);
  terminal?.focus();
  scheduleFit(index);
};

window.updatePaneConfig = function updatePaneConfig(payload: UpdatePanePayload): void {
  try {
    const index = Number(payload.index);
    if (!Number.isFinite(index)) {
      return;
    }
    const pane = state.panes.get(index);
    if (!pane) {
      return;
    }
    const nextWorkingDirectory = typeof payload.workingDirectory === 'string'
      ? payload.workingDirectory
      : pane.descriptor.workingDirectory;
    if (typeof payload.title === 'string') {
      const resolvedTitle = normalisePaneTitle(index, payload.title, nextWorkingDirectory);
      pane.descriptor.title = resolvedTitle;
      pane.elements.title.textContent = resolvedTitle;
      pane.elements.title.title = `${resolvedTitle} — double-click to rename`;
    }
    if (typeof payload.workingDirectory === 'string') {
      pane.descriptor.workingDirectory = payload.workingDirectory;
    }
    if ('startupCommand' in payload) {
      pane.descriptor.startupCommand = typeof payload.startupCommand === 'string' ? payload.startupCommand : '';
    }
    if ('kind' in payload) {
      const nextKind = typeof payload.kind === 'string' ? payload.kind.trim().toLowerCase() : '';
      pane.descriptor.kind = nextKind === 'codex' || nextKind === 'claude' ? nextKind : 'shell';
    }
    if ('conversationSummary' in payload) {
      pane.descriptor.conversationSummary = typeof payload.conversationSummary === 'string'
        ? payload.conversationSummary.trim()
        : '';
    }

    const tab = state.tabs[pane.tabIndex];
    if (tab) {
      const tabPane = tab.panes.find((p) => p.index === index);
      if (tabPane) {
        if (typeof payload.title === 'string') {
          tabPane.title = normalisePaneTitle(index, payload.title, nextWorkingDirectory);
        }
        if (typeof payload.workingDirectory === 'string') {
          tabPane.workingDirectory = payload.workingDirectory;
        }
        if ('startupCommand' in payload) {
          tabPane.startupCommand = typeof payload.startupCommand === 'string' ? payload.startupCommand : '';
        }
        if ('kind' in payload) {
          const nextKind = typeof payload.kind === 'string' ? payload.kind.trim().toLowerCase() : '';
          tabPane.kind = nextKind === 'codex' || nextKind === 'claude' ? nextKind : 'shell';
        }
        if ('conversationSummary' in payload) {
          tabPane.conversationSummary = typeof payload.conversationSummary === 'string'
            ? payload.conversationSummary.trim()
            : '';
        }
      }
    }

    refreshPaneLocationActions(pane);
    updateVisiblePanes();
  } catch (error) {
    postLog({ type: 'pane-config-error', error: String(error), payload });
  }
};

window.removeCodigoTab = function removeCodigoTab(payload: unknown): void {
  try {
    const data = payload as RemoveTabPayload;
    const id = typeof data?.id === 'string' ? data.id : null;
    const fallbackIndex = Number(data?.index);
    const activeTabIndex = Number(data?.activeTabIndex);

    let index = id ? state.tabs.findIndex((tab) => tab.id === id) : -1;
    if (index === -1 && Number.isFinite(fallbackIndex)) {
      index = fallbackIndex;
    }
    if (index === -1) {
      return;
    }
    const removed = removeTabAt(index, { activeTabIndex });
    if (removed) {
      focusFirstTerminal();
    }
  } catch (error) {
    postLog({ type: 'remove-tab-error', error: String(error), payload });
  }
};

window.removeCodigoPane = function removeCodigoPane(payload: unknown): void {
  try {
    const data = payload as RemovePanePayload;
    const index = Number(data?.index);
    if (!Number.isFinite(index)) {
      return;
    }
    const tabId = typeof data?.tabId === 'string' ? data.tabId : undefined;
    const tabIndex = Number(data?.tabIndex);
    const removed = removePaneAt(index, {
      tabId,
      tabIndex: Number.isFinite(tabIndex) ? tabIndex : undefined,
    });
    if (removed) {
      focusFirstTerminal();
    }
  } catch (error) {
    postLog({ type: 'remove-pane-error', error: String(error), payload });
  }
};
