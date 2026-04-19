import { state } from './state.js';
import {
  grid,
  previewHost,
  previewInput,
  primaryColumn,
  primaryAgentSwitcher,
  stackedColumn,
  primaryPaneContainer,
  stackedPaneContainer,
} from './dom.js';
import { normaliseTabs, normaliseStoredPreviewURL } from './dataTransforms.js';
import { createPane, updateVisiblePanes, focusFirstTerminal, refreshPaneCommandControls, refreshAllPaneGitStatus } from './panes.js';
import { renderTabBar, updateTabBarActiveState } from './tabs.js';
import { updateActivePreview } from './preview.js';
import { notifyNative } from './nativeBridge.js';
import { handleAllTabsCleared } from './tabActivity.js';
import { resetConversationPromptTracking } from './terminals.js';
import {
  applyColumnLayoutForTab,
  initialiseTabLayout,
  rememberActiveColumnLayoutState,
} from './columnLayout.js';
import { refreshGitHubControls } from './columnActions.js';
import type { AppSettingsState, TerminalCloudAction, TerminalEditorAction } from './types.js';
import { normaliseDirectoryKey, sanitizeCommandList, sanitizeLinkList } from './pathUtils.js';

interface InitialPayload {
  tabs?: unknown;
  activeTabIndex?: unknown;
  settings?: unknown;
}

function normaliseSettings(raw: unknown): AppSettingsState {
  const candidate = (raw as {
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
  }) ?? {};
  const playIdleChime = typeof candidate.playIdleChime === 'boolean' ? candidate.playIdleChime : true;
  const notifyOnIdle = typeof candidate.notifyOnIdle === 'boolean' ? candidate.notifyOnIdle : false;

  const terminalCommandsByPath: Record<string, string[]> = {};
  const byPathCandidate = candidate.terminalCommandsByPath;
  if (byPathCandidate && typeof byPathCandidate === 'object' && !Array.isArray(byPathCandidate)) {
    Object.entries(byPathCandidate as Record<string, unknown>).forEach(([rawKey, value]) => {
      const key = normaliseDirectoryKey(rawKey);
      const commands = sanitizeCommandList(value);
      terminalCommandsByPath[key] = commands;
    });
  }

  if (
    Object.keys(terminalCommandsByPath).length === 0
    && candidate.terminalCommands
    && typeof candidate.terminalCommands === 'object'
    && !Array.isArray(candidate.terminalCommands)
  ) {
    Object.entries(candidate.terminalCommands as Record<string, unknown>).forEach(([rawKey, value]) => {
      const key = normaliseDirectoryKey(rawKey);
      const commands = sanitizeCommandList(value);
      terminalCommandsByPath[key] = commands;
    });
  }

  if (Object.keys(terminalCommandsByPath).length === 0) {
    const legacyCommands = sanitizeCommandList(candidate.terminalCommands);
    if (legacyCommands.length > 0) {
      terminalCommandsByPath[''] = legacyCommands;
    }
  }

  const terminalLinksByPath: Record<string, string[]> = {};
  const linksCandidate = candidate.terminalLinksByPath;
  if (linksCandidate && typeof linksCandidate === 'object' && !Array.isArray(linksCandidate)) {
    Object.entries(linksCandidate as Record<string, unknown>).forEach(([rawKey, value]) => {
      const key = normaliseDirectoryKey(rawKey);
      const links = sanitizeLinkList(value);
      terminalLinksByPath[key] = links;
    });
  }

  const paneCommandSelections: Record<string, string> = {};
  if (candidate.paneCommandSelections && typeof candidate.paneCommandSelections === 'object') {
    Object.entries(candidate.paneCommandSelections as Record<string, unknown>).forEach(([key, value]) => {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string' && value.trim().length > 0) {
        paneCommandSelections[key] = value.trim();
      }
    });
  }

  const paneLinkSelections: Record<string, string> = {};
  if (candidate.paneLinkSelections && typeof candidate.paneLinkSelections === 'object') {
    Object.entries(candidate.paneLinkSelections as Record<string, unknown>).forEach(([key, value]) => {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string' && value.trim().length > 0) {
        paneLinkSelections[key] = value.trim();
      }
    });
  }

  const rawAction = typeof candidate.terminalCloudAction === 'string' ? candidate.terminalCloudAction : 'sync';
  let terminalCloudAction: TerminalCloudAction;
  if (rawAction === 'createPullRequest') {
    terminalCloudAction = 'createPullRequest';
  } else if (rawAction === 'customScript') {
    terminalCloudAction = 'customScript';
  } else {
    terminalCloudAction = 'sync';
  }

  const rawEditorAction = typeof candidate.terminalEditorAction === 'string'
    ? candidate.terminalEditorAction.toLowerCase()
    : 'cursor';
  let terminalEditorAction: TerminalEditorAction;
  if (rawEditorAction === 'vscode') {
    terminalEditorAction = 'vscode';
  } else if (rawEditorAction === 'custom') {
    terminalEditorAction = 'custom';
  } else {
    terminalEditorAction = 'cursor';
  }

  const terminalEditorCommand = typeof candidate.terminalEditorCommand === 'string'
    ? candidate.terminalEditorCommand.trim()
    : '';

  const terminalCloudCustomScript = typeof candidate.terminalCloudCustomScript === 'string'
    ? candidate.terminalCloudCustomScript.replace(/\r\n/g, '\n')
    : '';

  const rawConversationSummarySource = typeof candidate.conversationSummarySource === 'string'
    ? candidate.conversationSummarySource
    : 'off';
  const conversationSummarySource = rawConversationSummarySource === 'localCommand'
    ? 'localCommand'
    : rawConversationSummarySource === 'terminalTitle'
      ? 'terminalTitle'
      : 'off';

  const conversationSummaryCommand = typeof candidate.conversationSummaryCommand === 'string'
    ? candidate.conversationSummaryCommand.trim()
    : '';

  const githubAccountConnected = typeof candidate.githubAccountConnected === 'boolean'
    ? candidate.githubAccountConnected
    : false;

  return {
    playIdleChime,
    notifyOnIdle,
    terminalCommandsByPath,
    paneCommandSelections,
    terminalLinksByPath,
    paneLinkSelections,
    terminalCloudAction,
    terminalEditorAction,
    terminalEditorCommand,
    terminalCloudCustomScript,
    conversationSummarySource,
    conversationSummaryCommand,
    githubAccountConnected,
  };
}

function resetState(): void {
  if (primaryPaneContainer) {
    primaryPaneContainer.innerHTML = '';
  } else if (primaryColumn) {
    primaryColumn.innerHTML = '';
  }
  if (primaryAgentSwitcher) {
    primaryAgentSwitcher.innerHTML = '';
    primaryAgentSwitcher.classList.add('hidden');
  }
  if (stackedPaneContainer) {
    stackedPaneContainer.innerHTML = '';
  } else if (stackedColumn) {
    stackedColumn.innerHTML = '';
  }
  if (!primaryPaneContainer || !stackedPaneContainer) {
    grid.querySelectorAll('.pane').forEach((pane) => pane.remove());
  }
  if (previewHost) {
    previewHost.innerHTML = '';
  }
  state.panes.clear();
  state.terminals.clear();
  state.pendingPayloads.clear();
  state.pendingGitStatuses.clear();
  state.pendingGitHubActionStatuses.clear();
  state.scheduledFits.clear();
  state.decoders.clear();
  resetConversationPromptTracking();
  state.columnLayoutByTab.clear();
  state.preview.frames.clear();
  state.preview.urls.clear();
  state.preview.activePreviewTabId = null;
  state.focusedPrimaryPaneByTab.clear();
  state.unreadPrimaryOutputByPane.clear();
  if (previewInput) {
    previewInput.value = '';
  }
}

export function initialiseFromPayload(payload: InitialPayload): void {
  handleAllTabsCleared();
  const settings = normaliseSettings(payload.settings);
  state.settings.playIdleChime = settings.playIdleChime;
  state.settings.notifyOnIdle = settings.notifyOnIdle;
  state.settings.terminalCommandsByPath = Object.fromEntries(
    Object.entries(settings.terminalCommandsByPath).map(([key, values]) => [key, [...values]])
  );
  state.settings.paneCommandSelections = { ...settings.paneCommandSelections };
  state.settings.terminalLinksByPath = Object.fromEntries(
    Object.entries(settings.terminalLinksByPath).map(([key, values]) => [key, [...values]])
  );
  state.settings.paneLinkSelections = { ...settings.paneLinkSelections };
  state.settings.terminalCloudAction = settings.terminalCloudAction;
  state.settings.terminalEditorAction = settings.terminalEditorAction;
  state.settings.terminalEditorCommand = settings.terminalEditorCommand;
  state.settings.terminalCloudCustomScript = settings.terminalCloudCustomScript;
  state.settings.conversationSummarySource = settings.conversationSummarySource;
  state.settings.conversationSummaryCommand = settings.conversationSummaryCommand;
  state.settings.githubAccountConnected = settings.githubAccountConnected;
  state.tabs = normaliseTabs(payload.tabs);

  if (state.tabs.length === 0) {
    state.activeTabIndex = 0;
  } else {
    const requestedIndex = Number(payload.activeTabIndex);
    state.activeTabIndex = Number.isFinite(requestedIndex)
      ? Math.min(Math.max(requestedIndex, 0), state.tabs.length - 1)
      : 0;
  }

  resetState();

  state.tabs.forEach((tab) => {
    initialiseTabLayout(tab.id);
  });

  state.tabs.forEach((tab) => {
    tab.previewTabs = tab.previewTabs.map((previewTab, index) => {
      const url = normaliseStoredPreviewURL(previewTab.url);
      const title = previewTab.title && previewTab.title.trim().length > 0
        ? previewTab.title
        : `Preview ${index + 1}`;
      state.preview.urls.set(previewTab.id, url);
      return { id: previewTab.id, title, url };
    });
    if (!tab.activePreviewTabId || !tab.previewTabs.some((preview) => preview.id === tab.activePreviewTabId)) {
      tab.activePreviewTabId = tab.previewTabs[0]?.id ?? null;
    }
  });

  const activeTab = state.tabs[state.activeTabIndex];
  state.preview.activePreviewTabId = activeTab?.activePreviewTabId ?? null;

  state.tabs.forEach((tab, tabIndex) => {
    tab.panes.forEach((pane) => {
      createPane(tabIndex, pane);
    });
  });

  renderTabBar();
  updateTabBarActiveState();
  applyColumnLayoutForTab(activeTab?.id ?? null);
  rememberActiveColumnLayoutState(activeTab?.id ?? null);
  updateVisiblePanes();
  focusFirstTerminal();
  updateActivePreview();
  refreshPaneCommandControls();
  refreshGitHubControls();
  refreshAllPaneGitStatus();
  notifyNative('uiReady', { total: state.panes.size });
}
