import { state } from './state.js';
import {
  appRoot,
  grid,
  primaryColumn,
  primaryAgentSwitcher,
  stackedColumn,
  primaryPaneContainer,
  stackedPaneContainer,
} from './dom.js';
import { notifyNative, postLog } from './nativeBridge.js';
import { copyTextToClipboard } from './clipboard.js';
import { showContextMenu } from './contextMenu.js';
import {
  ensureTerminal,
  disposeTerminal,
  flushPendingPayload,
  observePaneContainer,
  scheduleFit,
  sendCommandToTerminal,
} from './terminals.js';
import {
  normalisePaneDescriptor,
  normalisePaneTitle,
} from './dataTransforms.js';
import { createIcon } from './icons.js';
import {
  registerPaneActivityIndicator,
  resetPaneActivity,
  retirePaneActivity,
  unregisterPaneActivityIndicator,
  syncPaneActivityIndicatorWithStatus,
} from './tabActivity.js';
import { openGitDetailsModal } from './gitDetailsModal.js';
import { confirmAction } from './confirmDialog.js';
import { openTerminalCommandManager, openTerminalLinkManager } from './commandManagerDialog.js';
import { showGitHubActionModal } from './githubActionModal.js';
import {
  getPaneRatios,
  setPaneRatios,
  removePaneFromLayout,
  prunePaneLayout,
} from './paneLayout.js';
import { ensureColumnVisible } from './columnLayout.js';
import { navigatePreview } from './preview.js';
import { normaliseDirectoryKey, sanitizeCommandList, sanitizeLinkList } from './pathUtils.js';
import type {
  PaneColumn,
  PaneDescriptor,
  PaneGitStatus,
  PaneGitHubActionStatus,
  PaneState,
  PaneStatus,
  TabState,
} from './types.js';

const PANE_COLUMNS: PaneColumn[] = ['primary', 'stacked'];
const MIN_PANE_FRACTION = 0.1;
const PRIMARY_AGENT_SWITCHER_THRESHOLD = 3;
const GITHUB_INDICATOR_CLASSES = [
  'pane-github-indicator--success',
  'pane-github-indicator--failure',
  'pane-github-indicator--progress',
  'pane-github-indicator--unknown',
];

function promptGitHubSignIn(): void {
  const message = 'Connect GitHub to sync changes. Open a terminal and run `gh auth login`, then try again.';
  if (typeof window.alert === 'function') {
    window.alert(message);
  } else {
    postLog({ type: 'github-auth-required', message });
  }
}

interface VerticalDragState {
  pointerId: number;
  column: PaneColumn;
  tabId: string;
  container: HTMLDivElement;
  handle: HTMLDivElement;
  paneOrder: PaneState[];
  ratios: Map<number, number>;
  pairRatioTotal: number;
  beforeIndex: number;
  afterIndex: number;
  startY: number;
  totalPixels: number;
  startBeforePixels: number;
  startAfterPixels: number;
}

let verticalDrag: VerticalDragState | null = null;
const latestVisiblePanesByColumn: Record<PaneColumn, PaneState[]> = {
  primary: [],
  stacked: [],
};

function getMaximizedPaneIndex(tabId: string | null, column: PaneColumn): number | null {
  if (!tabId) {
    return null;
  }
  const record = state.maximizedPaneByTab.get(tabId);
  if (!record) {
    return null;
  }
  const value = record[column];
  return typeof value === 'number' ? value : null;
}

function setMaximizedPaneIndex(tabId: string, column: PaneColumn, index: number): void {
  const existing = state.maximizedPaneByTab.get(tabId) ?? {};
  const next = { ...existing, [column]: index };
  state.maximizedPaneByTab.set(tabId, next);
}

function clearMaximizedPaneIndex(tabId: string, column: PaneColumn): void {
  const record = state.maximizedPaneByTab.get(tabId);
  if (record?.[column] === undefined) {
    return;
  }
  const next: Partial<Record<PaneColumn, number>> = { ...record };
  delete next[column];
  if (Object.keys(next).length === 0) {
    state.maximizedPaneByTab.delete(tabId);
  } else {
    state.maximizedPaneByTab.set(tabId, next);
  }
}

function getPrimaryPaneDescriptors(tab: TabState | null): PaneDescriptor[] {
  if (!tab) {
    return [];
  }
  return tab.panes.filter((pane) => pane.column === 'primary');
}

function getPrimaryPaneStates(tab: TabState | null): PaneState[] {
  if (!tab) {
    return [];
  }
  return getPrimaryPaneDescriptors(tab)
    .map((pane) => state.panes.get(pane.index) ?? null)
    .filter((pane): pane is PaneState => Boolean(pane));
}

function setFocusedPrimaryPaneIndex(tabId: string, paneIndex: number): void {
  if (!tabId || !Number.isFinite(paneIndex)) {
    return;
  }
  state.focusedPrimaryPaneByTab.set(tabId, paneIndex);
}

function clearFocusedPrimaryPaneIndex(tabId: string): void {
  if (!tabId) {
    return;
  }
  state.focusedPrimaryPaneByTab.delete(tabId);
}

function getUnreadPrimaryOutputCount(paneIndex: number): number {
  return Math.max(0, state.unreadPrimaryOutputByPane.get(paneIndex) ?? 0);
}

function clearUnreadPrimaryOutput(paneIndex: number): void {
  state.unreadPrimaryOutputByPane.delete(paneIndex);
}

function resolveFocusedPrimaryPaneIndex(tab: TabState | null): number | null {
  if (!tab) {
    return null;
  }
  const primaryPanes = getPrimaryPaneDescriptors(tab);
  if (primaryPanes.length === 0) {
    clearFocusedPrimaryPaneIndex(tab.id);
    return null;
  }
  const stored = state.focusedPrimaryPaneByTab.get(tab.id);
  if (typeof stored === 'number' && primaryPanes.some((pane) => pane.index === stored)) {
    return stored;
  }
  const fallback = primaryPanes[primaryPanes.length - 1]?.index ?? null;
  if (typeof fallback === 'number') {
    setFocusedPrimaryPaneIndex(tab.id, fallback);
  }
  return fallback;
}

function shouldUsePrimaryAgentSwitcher(
  tab: TabState | null,
  maximizedPrimaryPaneIndex: number | null = null,
): boolean {
  if (!tab || maximizedPrimaryPaneIndex !== null) {
    return false;
  }
  return getPrimaryPaneDescriptors(tab).length >= PRIMARY_AGENT_SWITCHER_THRESHOLD;
}

function focusPrimaryPane(index: number, { focusTerminal = true }: { focusTerminal?: boolean } = {}): void {
  const pane = state.panes.get(index);
  if (!pane || pane.descriptor.column !== 'primary') {
    return;
  }
  const tab = state.tabs[pane.tabIndex];
  if (!tab) {
    return;
  }
  const currentFocusedPrimaryPaneIndex = state.focusedPrimaryPaneByTab.get(tab.id);
  if (currentFocusedPrimaryPaneIndex === index) {
    clearUnreadPrimaryOutput(index);
    if (pane.tabIndex === state.activeTabIndex && focusTerminal && pane.status === 'connected') {
      const existingTerminal = state.terminals.get(index) ?? ensureTerminal(index);
      existingTerminal?.focus();
    }
    return;
  }
  clearUnreadPrimaryOutput(index);
  setFocusedPrimaryPaneIndex(tab.id, index);
  if (pane.tabIndex === state.activeTabIndex) {
    updateVisiblePanes();
    if (focusTerminal && pane.status === 'connected') {
      const terminal = state.terminals.get(index) ?? ensureTerminal(index);
      terminal?.focus();
    }
  }
}

function resolvePrimaryAgentActivityLabel(pane: PaneState): string {
  if (pane.status === 'disconnected') {
    return 'Disconnected';
  }
  if (pane.status === 'connecting') {
    return 'Starting';
  }
  const activity = pane.elements.header.dataset['activity'];
  if (activity === 'active') {
    return 'Working';
  }
  if (activity === 'idle') {
    return 'Ready';
  }
  return 'Connected';
}

function resolvePrimaryAgentActivityValue(pane: PaneState): string {
  if (pane.status === 'disconnected') {
    return 'disconnected';
  }
  if (pane.status === 'connecting') {
    return 'connecting';
  }
  return pane.elements.header.dataset['activity'] ?? 'idle';
}

function trimWorkingDirectory(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }
  const normalized = trimmed.replace(/[\\/]+$/, '');
  if (normalized.length <= 44) {
    return normalized;
  }
  return `…${normalized.slice(-44)}`;
}

function resolvePrimaryAgentSummaryText(pane: PaneState): string {
  if (state.settings.conversationSummarySource === 'off') {
    return pane.descriptor.title;
  }
  const summary = pane.descriptor.conversationSummary?.trim();
  if (summary) {
    return summary;
  }
  return pane.descriptor.title;
}

function renderPrimaryAgentSwitcher(
  tab: TabState | null,
  activeMaximizedByColumn: Partial<Record<PaneColumn, number>> = {},
): void {
  if (!primaryAgentSwitcher) {
    return;
  }

  primaryAgentSwitcher.innerHTML = '';

  const maximizedPrimaryPaneIndexRaw = activeMaximizedByColumn.primary;
  const maximizedPrimaryPaneIndex =
    typeof maximizedPrimaryPaneIndexRaw === 'number' ? maximizedPrimaryPaneIndexRaw : null;
  const shouldShow = shouldUsePrimaryAgentSwitcher(tab, maximizedPrimaryPaneIndex);
  primaryAgentSwitcher.classList.toggle('hidden', !shouldShow);

  if (!tab || !shouldShow) {
    return;
  }

  const focusedPrimaryPaneIndex = resolveFocusedPrimaryPaneIndex(tab);
  const primaryPanes = getPrimaryPaneStates(tab);

  primaryPanes.forEach((pane) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'primary-agent-switcher-item';
    item.setAttribute('role', 'listitem');
    const isActive = focusedPrimaryPaneIndex === pane.descriptor.index;
    item.dataset['active'] = isActive ? 'true' : 'false';
    item.setAttribute('aria-current', isActive ? 'true' : 'false');
    item.dataset['status'] = pane.status;
    item.dataset['activity'] = resolvePrimaryAgentActivityValue(pane);
    const tooltipSummary = resolvePrimaryAgentSummaryText(pane);
    const tooltipPath = trimWorkingDirectory(pane.descriptor.workingDirectory ?? '');
    item.title = tooltipPath ? `${tooltipSummary}\n${tooltipPath}` : tooltipSummary;
    item.addEventListener('click', () => {
      focusPrimaryPane(pane.descriptor.index);
    });

    const topRow = document.createElement('span');
    topRow.className = 'primary-agent-switcher-row';

    const summary = document.createElement('span');
    summary.className = 'primary-agent-switcher-summary';

    const title = document.createElement('span');
    title.className = 'primary-agent-switcher-title';
    title.textContent = resolvePrimaryAgentSummaryText(pane);
    summary.appendChild(title);

    const status = document.createElement('span');
    status.className = 'primary-agent-switcher-status';
    status.textContent = resolvePrimaryAgentActivityLabel(pane);
    const statusGroup = document.createElement('span');
    statusGroup.className = 'primary-agent-switcher-status-group';
    statusGroup.appendChild(status);

    const unreadCount = getUnreadPrimaryOutputCount(pane.descriptor.index);
    if (unreadCount > 0) {
      const unread = document.createElement('span');
      unread.className = 'primary-agent-switcher-unread';
      unread.textContent = unreadCount >= 99 ? '99+' : String(unreadCount);
      unread.title = unreadCount === 1 ? '1 unread output update' : `${unreadCount} unread output updates`;
      unread.setAttribute('aria-label', unread.title);
      statusGroup.appendChild(unread);
    }

    topRow.appendChild(summary);
    topRow.appendChild(statusGroup);
    item.appendChild(topRow);

    primaryAgentSwitcher.appendChild(item);
  });
}

export function notePrimaryPaneOutput(index: number, text?: string): void {
  if (!Number.isFinite(index) || typeof text !== 'string' || text.length === 0) {
    return;
  }
  const pane = state.panes.get(index);
  if (!pane || pane.descriptor.column !== 'primary') {
    return;
  }
  const tab = state.tabs[pane.tabIndex];
  if (!tab) {
    return;
  }

  if (pane.descriptor.kind === 'codex' && !state.promptArmedPrimaryPanes.has(index)) {
    clearUnreadPrimaryOutput(index);
    return;
  }

  const activeMaximizedByColumn = state.maximizedPaneByTab.get(tab.id) ?? {};
  const primaryMaximizedIndexRaw = activeMaximizedByColumn.primary;
  const primaryMaximizedIndex =
    typeof primaryMaximizedIndexRaw === 'number' ? primaryMaximizedIndexRaw : null;
  const primaryFocusMode = shouldUsePrimaryAgentSwitcher(tab, primaryMaximizedIndex);
  const focusedPrimaryPaneIndex = primaryFocusMode ? resolveFocusedPrimaryPaneIndex(tab) : null;
  const isActiveTab = pane.tabIndex === state.activeTabIndex;
  const hiddenByMaximize =
    primaryMaximizedIndex !== null
    && primaryMaximizedIndex !== pane.descriptor.index;
  const hiddenByPrimaryFocus =
    primaryFocusMode
    && focusedPrimaryPaneIndex !== null
    && focusedPrimaryPaneIndex !== pane.descriptor.index;
  const shouldCountUnread = !isActiveTab || hiddenByMaximize || hiddenByPrimaryFocus;

  if (!shouldCountUnread) {
    clearUnreadPrimaryOutput(index);
    return;
  }

  const previous = getUnreadPrimaryOutputCount(index);
  state.unreadPrimaryOutputByPane.set(index, Math.min(previous + 1, 99));

  if (isActiveTab) {
    renderPrimaryAgentSwitcher(tab, activeMaximizedByColumn);
  }
}

function copyPaneWorkingDirectory(index: number): void {
  const pane = state.panes.get(index);
  const workingDirectory = typeof pane?.descriptor?.workingDirectory === 'string'
    ? pane.descriptor.workingDirectory
    : '';
  copyTextToClipboard(workingDirectory);
}

function resolvePaneHost(tabIndex: number, descriptorIndex: number): HTMLElement {
  const tab = state.tabs[tabIndex];
  const primaryHost = primaryPaneContainer ?? primaryColumn ?? grid;
  const stackedHost = stackedPaneContainer ?? stackedColumn ?? grid;
  if (tab) {
    const descriptor = tab.panes.find((pane) => pane.index === descriptorIndex);
    if (descriptor?.column === 'primary') {
      return primaryHost;
    }
  }
  return stackedHost;
}

function reflowPaneHosts(): void {
  const primaryHost = primaryPaneContainer ?? primaryColumn ?? grid;
  const stackHost = stackedPaneContainer ?? stackedColumn ?? grid;
  const primaryFragment = document.createDocumentFragment();
  const stackFragment = document.createDocumentFragment();
  const processed = new Set<number>();

  state.tabs.forEach((tab, tabIndex) => {
    tab.panes.forEach((paneDescriptor) => {
      const paneState = state.panes.get(paneDescriptor.index);
      if (!paneState || processed.has(paneDescriptor.index)) {
        return;
      }
      processed.add(paneDescriptor.index);
      const container = paneState.elements.container;
      if (!container) {
        return;
      }
      const host = resolvePaneHost(tabIndex, paneDescriptor.index);
      if (host === primaryHost) {
        primaryFragment.appendChild(container);
      } else {
        stackFragment.appendChild(container);
      }
    });
  });

  if (primaryFragment.childNodes.length > 0) {
    primaryHost.appendChild(primaryFragment);
  }

  if (stackHost && stackFragment.childNodes.length > 0) {
    stackHost.appendChild(stackFragment);
  }

  state.panes.forEach((paneState, paneIndex) => {
    if (processed.has(paneIndex)) {
      return;
    }
    const container = paneState.elements.container;
    if (!container) {
      return;
    }
    const fallbackHost = (typeof paneState.tabIndex === 'number')
      ? resolvePaneHost(paneState.tabIndex, paneIndex)
      : stackHost;
    (fallbackHost ?? stackHost).appendChild(container);
  });
}

function resolveActiveTab(): TabState | null {
  if (state.tabs.length === 0) {
    return null;
  }
  const safeIndex = Math.min(Math.max(state.activeTabIndex, 0), state.tabs.length - 1);
  return state.tabs[safeIndex] ?? null;
}

export function updateWorkspaceEmptyState(): void {
  const tabCount = state.tabs.length;
  const activeTab = resolveActiveTab();
  const paneCount = activeTab?.panes.length ?? 0;
  const isEmpty = tabCount === 0 || paneCount === 0;
  appRoot.classList.toggle('app-empty', isEmpty);
}

function getPaneContainer(column: PaneColumn): HTMLDivElement {
  return column === 'primary'
    ? (primaryPaneContainer ?? primaryColumn ?? grid)
    : (stackedPaneContainer ?? stackedColumn ?? grid);
}

function collectOrderedPaneStates(
  tab: TabState,
  column: PaneColumn,
  visible: PaneState[],
): PaneState[] {
  if (visible.length === 0) {
    return [];
  }
  const lookup = new Map<number, PaneState>();
  visible.forEach((pane) => {
    lookup.set(pane.descriptor.index, pane);
  });
  return tab.panes
    .filter((descriptor) => descriptor.column === column)
    .map((descriptor) => lookup.get(descriptor.index) ?? null)
    .filter((pane): pane is PaneState => Boolean(pane));
}

function setPaneFlexRatios(panes: PaneState[], ratios: number[]): void {
  const multi = panes.length > 1;
  panes.forEach((pane, index) => {
    const container = pane.elements.container;
    if (pane.collapsed) {
      container.style.flexGrow = '0';
      container.style.flexBasis = 'auto';
      return;
    }
    if (!multi) {
      container.style.flexGrow = '1';
      container.style.flexBasis = 'auto';
      return;
    }
    const ratio = ratios[index] ?? (1 / panes.length);
    container.style.flexGrow = String(Math.max(ratio, 0.0001));
    container.style.flexBasis = '0%';
  });
}

function ensureCommandStore(): Record<string, string[]> {
  if (!state.settings.terminalCommandsByPath || typeof state.settings.terminalCommandsByPath !== 'object') {
    state.settings.terminalCommandsByPath = {};
  }
  return state.settings.terminalCommandsByPath;
}

function resolvePaneCommandKey(pane: PaneState | null | undefined): string {
  if (!pane) {
    return '';
  }
  return normaliseDirectoryKey(pane.descriptor.workingDirectory ?? '');
}

function getCommandsForKey(key: string): string[] {
  const store = ensureCommandStore();
  const commands = store[key];
  if (Array.isArray(commands)) {
    return commands;
  }
  const fallback = store[''];
  return Array.isArray(fallback) ? fallback : [];
}

function getCommandsForPane(pane: PaneState): string[] {
  const key = resolvePaneCommandKey(pane);
  return getCommandsForKey(key);
}

function setCommandsForKey(key: string, commands: string[]): void {
  const store = ensureCommandStore();
  store[key] = commands;
}

function ensureLinkStore(): Record<string, string[]> {
  if (!state.settings.terminalLinksByPath || typeof state.settings.terminalLinksByPath !== 'object') {
    state.settings.terminalLinksByPath = {};
  }
  return state.settings.terminalLinksByPath;
}

function resolvePaneLinkKey(pane: PaneState | null | undefined): string {
  if (!pane) {
    return '';
  }
  return normaliseDirectoryKey(pane.descriptor.workingDirectory ?? '');
}

function getLinksForKey(key: string): string[] {
  const store = ensureLinkStore();
  const links = store[key];
  if (Array.isArray(links)) {
    return links;
  }
  const fallback = store[''];
  return Array.isArray(fallback) ? fallback : [];
}

function getLinksForPane(pane: PaneState): string[] {
  const key = resolvePaneLinkKey(pane);
  return getLinksForKey(key);
}

function setLinksForKey(key: string, links: string[]): void {
  const store = ensureLinkStore();
  store[key] = links;
}

function prunePaneSelectionsForKey(key: string, validCommands: string[]): void {
  const allowed = new Set(validCommands);
  const selections = state.settings.paneCommandSelections;
  state.panes.forEach((pane) => {
    if (resolvePaneCommandKey(pane) !== key) {
      return;
    }
    const paneId = pane.descriptor.id;
    const command = selections[paneId];
    if (typeof command !== 'string' || !allowed.has(command)) {
      delete selections[paneId];
    }
  });
}

function refreshCommandTriggersForKey(key: string): void {
  const commands = getCommandsForKey(key);
  state.panes.forEach((paneState) => {
    if (paneState.descriptor.column !== 'stacked') {
      return;
    }
    if (resolvePaneCommandKey(paneState) !== key) {
      return;
    }
    const paneTrigger = paneState.elements.commandTrigger;
    if (!paneTrigger) {
      return;
    }
    const restored = getStoredPaneCommand(paneState.descriptor.id, commands);
    updateCommandTrigger(paneTrigger, commands, restored);
  });
}

function prunePaneLinkSelectionsForKey(key: string, validLinks: string[]): void {
  const allowed = new Set(validLinks);
  const selections = state.settings.paneLinkSelections;
  state.panes.forEach((pane) => {
    if (resolvePaneLinkKey(pane) !== key) {
      return;
    }
    const paneId = pane.descriptor.id;
    const link = selections[paneId];
    if (typeof link !== 'string' || !allowed.has(link)) {
      delete selections[paneId];
    }
  });
}

function refreshLinkTriggersForKey(key: string): void {
  const links = getLinksForKey(key);
  state.panes.forEach((paneState) => {
    if (paneState.descriptor.column !== 'stacked') {
      return;
    }
    if (resolvePaneLinkKey(paneState) !== key) {
      return;
    }
    const trigger = paneState.elements.linkTrigger;
    if (!trigger) {
      return;
    }
    const restored = getStoredPaneLink(paneState.descriptor.id, links);
    updateLinkTrigger(trigger, links, restored);
  });
}

function getStoredPaneCommand(paneId: string, commands: string[]): string | null {
  const stored = state.settings.paneCommandSelections[paneId];
  if (stored && commands.includes(stored)) {
    return stored;
  }
  return commands[0] ?? null;
}

function getStoredPaneLink(paneId: string, links: string[]): string | null {
  const stored = state.settings.paneLinkSelections[paneId];
  if (stored && links.includes(stored)) {
    return stored;
  }
  return links[0] ?? null;
}

let activeSelectionMenu: HTMLDivElement | null = null;
let activeSelectionMenuCleanup: (() => void)[] = [];
let activeSelectionTrigger: HTMLButtonElement | null = null;

function closeSelectionMenu(restoreFocus: boolean): void {
  activeSelectionMenuCleanup.forEach((teardown) => {
    try {
      teardown();
    } catch (error) {
      console.warn('Failed to remove selection menu listener', error);
    }
  });
  activeSelectionMenuCleanup = [];

  if (activeSelectionMenu) {
    activeSelectionMenu.remove();
    activeSelectionMenu = null;
  }

  if (activeSelectionTrigger) {
    activeSelectionTrigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      const trigger = activeSelectionTrigger;
      requestAnimationFrame(() => {
        if (document.contains(trigger)) {
          trigger.focus();
        }
      });
    }
    activeSelectionTrigger = null;
  }
}

function updateCommandTrigger(
  trigger: HTMLButtonElement,
  commands: string[],
  selected: string | null,
): void {
  const resolved = typeof selected === 'string' && selected.length > 0 ? selected : '';
  const label = trigger.querySelector<HTMLSpanElement>('.pane-command-trigger-label');
  const hasCommands = commands.length > 0;
  const placeholder = hasCommands ? 'Select command' : 'Add commands…';
  const text = resolved || placeholder;

  if (label) {
    label.textContent = text;
  } else {
    trigger.textContent = text;
  }

  trigger.dataset['currentSelection'] = resolved;
  trigger.dataset['hasCommands'] = hasCommands ? 'true' : 'false';
  trigger.title = resolved || (hasCommands ? 'Select a saved command' : 'Add a command');

  if (resolved) {
    trigger.classList.remove('is-empty');
  } else {
    trigger.classList.add('is-empty');
  }

  trigger.setAttribute('aria-haspopup', 'menu');
  const isExpanded = activeSelectionTrigger === trigger;
  trigger.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
}

function setPaneCommandSelection(paneId: string, command: string): void {
  state.settings.paneCommandSelections[paneId] = command;
  notifyNative('updatePaneCommandSelection', { paneId, command });
}

function updateLinkTrigger(
  trigger: HTMLButtonElement,
  links: string[],
  selected: string | null,
): void {
  const resolved = typeof selected === 'string' && selected.length > 0 ? selected : '';
  const label = trigger.querySelector<HTMLSpanElement>('.pane-command-trigger-label');
  const hasLinks = links.length > 0;
  const placeholder = hasLinks ? 'Select link' : 'Add links…';
  const text = resolved || placeholder;

  if (label) {
    label.textContent = text;
  } else {
    trigger.textContent = text;
  }

  trigger.dataset['currentSelection'] = resolved;
  trigger.dataset['hasCommands'] = hasLinks ? 'true' : 'false';
  trigger.title = resolved || (hasLinks ? 'Select a saved link' : 'Add a link');

  if (resolved) {
    trigger.classList.remove('is-empty');
  } else {
    trigger.classList.add('is-empty');
  }

  trigger.setAttribute('aria-haspopup', 'menu');
  const isExpanded = activeSelectionTrigger === trigger;
  trigger.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
}

function setPaneLinkSelection(paneId: string, link: string): void {
  state.settings.paneLinkSelections[paneId] = link;
  notifyNative('updatePaneLinkSelection', { paneId, link });
}

type PaneSelectionMenuMode = 'select' | 'invoke';

interface PaneSelectionMenuConfig {
  kind: 'command' | 'link';
  getValues: (pane: PaneState) => string[];
  getStoredSelection: (paneId: string, values: string[]) => string | null;
  updateTrigger: (trigger: HTMLButtonElement, values: string[], selected: string | null) => void;
  setSelection: (pane: PaneState, value: string) => void;
  onInvoke: (pane: PaneState, value: string) => void;
  openManageDialog: (pane: PaneState, trigger: HTMLButtonElement) => Promise<string>;
  emptyMessage: string;
  manageLabel: (hasValues: boolean) => string;
}

function showPaneSelectionMenu(
  pane: PaneState,
  trigger: HTMLButtonElement,
  mode: PaneSelectionMenuMode,
  config: PaneSelectionMenuConfig,
): void {
  const values = config.getValues(pane);
  closeSelectionMenu(false);

  if (!document.body) {
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'pane-command-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;

  const currentSelection = trigger.dataset['currentSelection'] ?? '';
  const interactiveItems: HTMLButtonElement[] = [];

  if (values.length > 0) {
    values.forEach((value) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pane-command-menu-item';
      item.textContent = value;
      item.setAttribute('role', 'menuitemradio');
      const isSelected = value === currentSelection;
      item.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      if (isSelected) {
        item.classList.add('is-selected');
      }
      item.addEventListener('click', () => {
        closeSelectionMenu(false);
        const updatedValues = config.getValues(pane);
        trigger.dataset['currentSelection'] = value;
        config.updateTrigger(trigger, updatedValues, value);
        config.setSelection(pane, value);
        if (mode === 'invoke') {
          config.onInvoke(pane, value);
        }
      });
      interactiveItems.push(item);
      menu.appendChild(item);
    });
  } else {
    const emptyState = document.createElement('div');
    emptyState.className = 'pane-command-menu-empty';
    emptyState.textContent = config.emptyMessage;
    menu.appendChild(emptyState);
  }

  const manageButton = document.createElement('button');
  manageButton.type = 'button';
  manageButton.className = 'pane-command-menu-item pane-command-menu-manage';
  manageButton.textContent = config.manageLabel(values.length > 0);
  manageButton.setAttribute('role', 'menuitem');
  manageButton.addEventListener('click', () => {
    void (async () => {
      closeSelectionMenu(false);
      const previous = trigger.dataset['currentSelection'] ?? '';
      const result = await config.openManageDialog(pane, trigger);
      const latestValues = config.getValues(pane);
      const nextSelection = result ?? trigger.dataset['currentSelection'] ?? '';
      if (mode === 'invoke' && nextSelection && (nextSelection !== previous || previous === '')) {
        config.onInvoke(pane, nextSelection);
      }
      config.updateTrigger(trigger, latestValues, nextSelection || null);
    })();
  });
  interactiveItems.push(manageButton);
  menu.appendChild(manageButton);

  document.body.appendChild(menu);

  const triggerRect = trigger.getBoundingClientRect();
  const minWidth = Math.max(triggerRect.width, 220);
  menu.style.minWidth = `${Math.round(minWidth)}px`;

  const { innerWidth, innerHeight } = window;
  let left = triggerRect.left;
  let top = triggerRect.bottom + 8;

  const rect = menu.getBoundingClientRect();
  if (left + rect.width > innerWidth - 8) {
    left = Math.max(8, innerWidth - rect.width - 8);
  }
  if (top + rect.height > innerHeight - 8) {
    const alternateTop = triggerRect.top - rect.height - 8;
    top = alternateTop >= 8 ? alternateTop : Math.max(8, innerHeight - rect.height - 8);
  }

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  activeSelectionMenu = menu;
  activeSelectionTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');

  const focusable = interactiveItems.filter((item) => item instanceof HTMLButtonElement && !item.disabled);
  const focusIndex = focusable.findIndex((item) => item.classList.contains('is-selected'));
  const initialFocus = focusIndex >= 0 ? focusable[focusIndex] : focusable[0];

  requestAnimationFrame(() => {
    initialFocus?.focus();
  });

  const handleClick = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (!menu.contains(target ?? null) && !trigger.contains(target ?? null)) {
      closeSelectionMenu(true);
    }
  };

  const handleFocus = (event: FocusEvent) => {
    const target = event.target as Node | null;
    if (!menu.contains(target ?? null) && target !== trigger) {
      closeSelectionMenu(false);
    }
  };

  const handleKey = (event: KeyboardEvent) => {
    if (!activeSelectionMenu) {
      return;
    }
    const active = document.activeElement as HTMLButtonElement | null;
    const index = focusable.findIndex((item) => item === active);

    if (event.key === 'Escape') {
      event.preventDefault();
      closeSelectionMenu(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!focusable.length) {
        return;
      }
      let nextIndex = index;
      if (nextIndex < 0) {
        nextIndex = event.key === 'ArrowDown' ? 0 : focusable.length - 1;
      } else {
        nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1;
      }
      if (nextIndex >= focusable.length) {
        nextIndex = 0;
      } else if (nextIndex < 0) {
        nextIndex = focusable.length - 1;
      }
      focusable[nextIndex]?.focus();
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusable[0]?.focus();
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus();
    }
  };

  const handleResize = () => {
    closeSelectionMenu(false);
  };

  const handleBlur = () => {
    closeSelectionMenu(false);
  };

  document.addEventListener('mousedown', handleClick, true);
  document.addEventListener('focusin', handleFocus, true);
  document.addEventListener('keydown', handleKey, true);
  window.addEventListener('resize', handleResize);
  window.addEventListener('blur', handleBlur);

  activeSelectionMenuCleanup = [
    () => document.removeEventListener('mousedown', handleClick, true),
    () => document.removeEventListener('focusin', handleFocus, true),
    () => document.removeEventListener('keydown', handleKey, true),
    () => window.removeEventListener('resize', handleResize),
    () => window.removeEventListener('blur', handleBlur),
  ];
}

async function handleManageCommands(
  pane: PaneState,
  trigger: HTMLButtonElement,
): Promise<string | null> {
  const key = resolvePaneCommandKey(pane);
  const existing = [...getCommandsForKey(key)];
  const response = await openTerminalCommandManager(existing);
  if (response === null) {
    const restored = getStoredPaneCommand(pane.descriptor.id, existing);
    updateCommandTrigger(trigger, existing, restored);
    return restored;
  }

  const commands = sanitizeCommandList(response);

  const unchanged = commands.length === existing.length
    && commands.every((value, index) => value === existing[index]);
  if (unchanged) {
    const restored = getStoredPaneCommand(pane.descriptor.id, existing);
    updateCommandTrigger(trigger, existing, restored);
    return restored;
  }

  setCommandsForKey(key, commands);
  prunePaneSelectionsForKey(key, commands);
  notifyNative('updateTerminalCommandList', {
    commands,
    workingDirectory: pane.descriptor.workingDirectory ?? '',
  });

  refreshCommandTriggersForKey(key);

  return getStoredPaneCommand(pane.descriptor.id, getCommandsForKey(key));
}

async function openManageCommandDialog(
  pane: PaneState,
  trigger: HTMLButtonElement,
): Promise<string> {
  const updated = await handleManageCommands(pane, trigger) ?? '';
  const commands = getCommandsForPane(pane);
  const restored = getStoredPaneCommand(pane.descriptor.id, commands) ?? '';
  const effective = updated || restored;
  updateCommandTrigger(trigger, commands, effective || null);
  return effective;
}

function runPaneCommand(pane: PaneState, command: string): void {
  if (!command) {
    return;
  }
  setPaneCommandSelection(pane.descriptor.id, command);
  sendCommandToTerminal(pane.descriptor.index, command);
}

async function handleManageLinks(
  pane: PaneState,
  trigger: HTMLButtonElement,
): Promise<string | null> {
  const key = resolvePaneLinkKey(pane);
  const existing = [...getLinksForKey(key)];
  const response = await openTerminalLinkManager(existing);
  if (response === null) {
    const restored = getStoredPaneLink(pane.descriptor.id, existing);
    updateLinkTrigger(trigger, existing, restored);
    return restored;
  }

  const links = sanitizeLinkList(response);

  const unchanged = links.length === existing.length
    && links.every((value, index) => value === existing[index]);
  if (unchanged) {
    const restored = getStoredPaneLink(pane.descriptor.id, existing);
    updateLinkTrigger(trigger, existing, restored);
    return restored;
  }

  setLinksForKey(key, links);
  prunePaneLinkSelectionsForKey(key, links);
  notifyNative('updateTerminalLinkList', {
    links,
    workingDirectory: pane.descriptor.workingDirectory ?? '',
  });

  refreshLinkTriggersForKey(key);

  return getStoredPaneLink(pane.descriptor.id, getLinksForKey(key));
}

async function openManageLinkDialog(
  pane: PaneState,
  trigger: HTMLButtonElement,
): Promise<string> {
  const updated = await handleManageLinks(pane, trigger) ?? '';
  const links = getLinksForPane(pane);
  const restored = getStoredPaneLink(pane.descriptor.id, links) ?? '';
  const effective = updated || restored;
  updateLinkTrigger(trigger, links, effective || null);
  return effective;
}

function openPaneLink(pane: PaneState, link: string): void {
  if (!link) {
    return;
  }
  setPaneLinkSelection(pane.descriptor.id, link);
  ensureColumnVisible('preview');
  navigatePreview(link);
}

const commandMenuConfig: PaneSelectionMenuConfig = {
  kind: 'command',
  getValues: (pane) => getCommandsForPane(pane),
  getStoredSelection: (paneId, values) => getStoredPaneCommand(paneId, values),
  updateTrigger: (trigger, values, selected) => updateCommandTrigger(trigger, values, selected),
  setSelection: (pane, value) => setPaneCommandSelection(pane.descriptor.id, value),
  onInvoke: (pane, value) => runPaneCommand(pane, value),
  openManageDialog: (pane, trigger) => openManageCommandDialog(pane, trigger),
  emptyMessage: 'No saved commands yet.',
  manageLabel: (hasValues) => (hasValues ? 'Manage commands…' : 'Add commands…'),
};

const linkMenuConfig: PaneSelectionMenuConfig = {
  kind: 'link',
  getValues: (pane) => getLinksForPane(pane),
  getStoredSelection: (paneId, values) => getStoredPaneLink(paneId, values),
  updateTrigger: (trigger, values, selected) => updateLinkTrigger(trigger, values, selected),
  setSelection: (pane, value) => setPaneLinkSelection(pane.descriptor.id, value),
  onInvoke: (pane, value) => openPaneLink(pane, value),
  openManageDialog: (pane, trigger) => openManageLinkDialog(pane, trigger),
  emptyMessage: 'No saved links yet.',
  manageLabel: (hasValues) => (hasValues ? 'Manage links…' : 'Add links…'),
};

function attachPaneCommandControls(pane: PaneState): void {
  if (pane.descriptor.column !== 'stacked') {
    return;
  }
  const header = pane.elements.header;
  const actions = pane.elements.actions;
  if (!header || !actions) {
    return;
  }

  let trigger: HTMLButtonElement | undefined = pane.elements.commandTrigger;
  let playButton: HTMLButtonElement | undefined = pane.elements.commandPlayButton;

  const needsNewControls =
    !trigger ||
    !playButton ||
    !trigger.isConnected ||
    !playButton.isConnected;

  if (needsNewControls) {
    const existingContainer = trigger?.closest('.pane-command-control');
    existingContainer?.remove();

    const container = document.createElement('div');
    container.className = 'pane-command-control';
    const wrapper = document.createElement('div');
    wrapper.className = 'pane-command-trigger-wrapper';

    const newTrigger = document.createElement('button');
    newTrigger.type = 'button';
    newTrigger.className = 'pane-command-trigger';
    newTrigger.dataset['paneId'] = pane.descriptor.id;
    newTrigger.setAttribute('aria-haspopup', 'menu');
    newTrigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'pane-command-trigger-label';
    newTrigger.appendChild(label);

    const chevron = createIcon('chevronDown');
    if (chevron) {
      chevron.classList.add('pane-command-trigger-icon');
      newTrigger.appendChild(chevron);
    }

    wrapper.appendChild(newTrigger);

    const newPlayButton = document.createElement('button');
    newPlayButton.type = 'button';
    newPlayButton.className = 'pane-command-play';
    const playIcon = createIcon('play');
    if (playIcon) {
      newPlayButton.appendChild(playIcon);
    } else {
      newPlayButton.textContent = '▶';
    }
    newPlayButton.title = 'Run command';
    newPlayButton.setAttribute('aria-label', 'Run command');

    container.appendChild(wrapper);
    container.appendChild(newPlayButton);
    header.insertBefore(container, actions);

    const openMenu = (mode: PaneSelectionMenuMode) => {
      showPaneSelectionMenu(pane, newTrigger, mode, commandMenuConfig);
    };

    newTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      openMenu('select');
    });

    newTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu('select');
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openMenu('select');
      }
    });

    newPlayButton.addEventListener('click', () => {
      const current = newTrigger.dataset['currentSelection'];
      if (current && current.length > 0) {
        commandMenuConfig.onInvoke(pane, current);
        return;
      }
      openMenu('invoke');
    });

    trigger = newTrigger;
    playButton = newPlayButton;
    pane.elements.commandTrigger = newTrigger;
    pane.elements.commandPlayButton = newPlayButton;
  }

  updatePaneCommandOptionsForPane(pane);
}

function updatePaneCommandOptionsForPane(pane: PaneState): void {
  if (pane.descriptor.column !== 'stacked') {
    return;
  }
  const trigger = pane.elements.commandTrigger;
  if (!trigger) {
    attachPaneCommandControls(pane);
    return;
  }
  const commands = getCommandsForPane(pane);
  const selected = getStoredPaneCommand(pane.descriptor.id, commands);
  updateCommandTrigger(trigger, commands, selected);
}

export function refreshPaneCommandControls(): void {
  state.panes.forEach((pane) => {
    if (pane.descriptor.column !== 'stacked') {
      return;
    }
    attachPaneCommandControls(pane);
    attachPaneLinkControls(pane);
  });
}

function attachPaneLinkControls(pane: PaneState): void {
  if (pane.descriptor.column !== 'stacked') {
    return;
  }
  const header = pane.elements.header;
  const actions = pane.elements.actions;
  if (!header || !actions) {
    return;
  }

  let trigger: HTMLButtonElement | undefined = pane.elements.linkTrigger;
  let openButton: HTMLButtonElement | undefined = pane.elements.linkOpenButton;

  const needsNewControls =
    !trigger ||
    !openButton ||
    !trigger.isConnected ||
    !openButton.isConnected;

  if (needsNewControls) {
    const existingContainer = trigger?.closest('.pane-link-control');
    existingContainer?.remove();

    const container = document.createElement('div');
    container.className = 'pane-command-control pane-link-control';

    const wrapper = document.createElement('div');
    wrapper.className = 'pane-command-trigger-wrapper';

    const newTrigger = document.createElement('button');
    newTrigger.type = 'button';
    newTrigger.className = 'pane-command-trigger pane-link-trigger';
    newTrigger.dataset['paneId'] = pane.descriptor.id;
    newTrigger.setAttribute('aria-haspopup', 'menu');
    newTrigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'pane-command-trigger-label';
    newTrigger.appendChild(label);

    const chevron = createIcon('chevronDown');
    if (chevron) {
      chevron.classList.add('pane-command-trigger-icon');
      newTrigger.appendChild(chevron);
    }

    wrapper.appendChild(newTrigger);

    const newOpenButton = document.createElement('button');
    newOpenButton.type = 'button';
    newOpenButton.className = 'pane-command-play pane-link-open';
    const openIcon = createIcon('openInNew');
    if (openIcon) {
      newOpenButton.appendChild(openIcon);
    } else {
      newOpenButton.textContent = '↗';
    }
    newOpenButton.title = 'Open link in preview';
    newOpenButton.setAttribute('aria-label', 'Open link in preview');

    container.appendChild(wrapper);
    container.appendChild(newOpenButton);
    header.insertBefore(container, actions);

    const openMenu = (mode: PaneSelectionMenuMode) => {
      showPaneSelectionMenu(pane, newTrigger, mode, linkMenuConfig);
    };

    newTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      openMenu('select');
    });

    newTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu('select');
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openMenu('select');
      }
    });

    newOpenButton.addEventListener('click', () => {
      const current = newTrigger.dataset['currentSelection'];
      if (current && current.length > 0) {
        linkMenuConfig.onInvoke(pane, current);
        return;
      }
      openMenu('invoke');
    });

    trigger = newTrigger;
    openButton = newOpenButton;
    pane.elements.linkTrigger = newTrigger;
    pane.elements.linkOpenButton = newOpenButton;
  }

  updatePaneLinkOptionsForPane(pane);
}

function updatePaneLinkOptionsForPane(pane: PaneState): void {
  if (pane.descriptor.column !== 'stacked') {
    return;
  }
  const trigger = pane.elements.linkTrigger;
  if (!trigger) {
    attachPaneLinkControls(pane);
    return;
  }
  const links = getLinksForPane(pane);
  const selected = getStoredPaneLink(pane.descriptor.id, links);
  updateLinkTrigger(trigger, links, selected);
}

function removeColumnHandles(container: HTMLElement): void {
  container.querySelectorAll('.pane-resize-handle--vertical').forEach((element) => {
    element.remove();
  });
}

function syncColumnHandles(column: PaneColumn, paneOrder: PaneState[]): void {
  const container = getPaneContainer(column);
  removeColumnHandles(container);
  if (paneOrder.length <= 1) {
    return;
  }
  for (let index = 0; index < paneOrder.length - 1; index += 1) {
    const before = paneOrder[index]!;
    const after = paneOrder[index + 1]!;
    if (before.collapsed || after.collapsed) {
      continue;
    }
    const handle = document.createElement('div');
    handle.className = 'pane-resize-handle pane-resize-handle--vertical';
    handle.dataset['column'] = column;
    handle.dataset['beforeIndex'] = String(before.descriptor.index);
    handle.dataset['afterIndex'] = String(after.descriptor.index);
    handle.addEventListener('pointerdown', (event) => {
      beginVerticalPaneResize(event, handle);
    });
    container.insertBefore(handle, after.elements.container);
  }
}

function cancelVerticalPaneDrag(): void {
  if (!verticalDrag) {
    return;
  }
  try {
    verticalDrag.handle.releasePointerCapture(verticalDrag.pointerId);
  } catch {
    // Pointer capture may already be released.
  }
  document.removeEventListener('pointermove', handleVerticalPointerMove);
  document.removeEventListener('pointerup', finishVerticalPaneResize);
  document.removeEventListener('pointercancel', finishVerticalPaneResize);
  document.body.classList.remove('resizing-rows');
  verticalDrag = null;
}

function beginVerticalPaneResize(event: PointerEvent, handle: HTMLDivElement): void {
  if (event.button !== undefined && event.button !== 0) {
    return;
  }
  const columnAttr = handle.dataset['column'];
  if (columnAttr !== 'primary' && columnAttr !== 'stacked') {
    return;
  }
  const column = columnAttr as PaneColumn;
  const beforeIndex = Number(handle.dataset['beforeIndex']);
  const afterIndex = Number(handle.dataset['afterIndex']);
  if (!Number.isFinite(beforeIndex) || !Number.isFinite(afterIndex)) {
    return;
  }

  const activeTab = resolveActiveTab();
  if (!activeTab) {
    return;
  }

  const visible = latestVisiblePanesByColumn[column];
  const paneOrder = collectOrderedPaneStates(activeTab, column, visible);
  if (paneOrder.length <= 1) {
    return;
  }

  const beforePane = paneOrder.find((pane) => pane.descriptor.index === beforeIndex);
  const afterPane = paneOrder.find((pane) => pane.descriptor.index === afterIndex);
  if (!beforePane || !afterPane) {
    return;
  }

  const beforeRect = beforePane.elements.container.getBoundingClientRect();
  const afterRect = afterPane.elements.container.getBoundingClientRect();
  const totalPixels = beforeRect.height + afterRect.height;
  if (!Number.isFinite(totalPixels) || totalPixels <= 0) {
    return;
  }

  const indices = paneOrder.map((pane) => pane.descriptor.index);
  const storedRatios = getPaneRatios(activeTab.id, column, indices);
  const ratioMap = new Map<number, number>();
  indices.forEach((index, idx) => {
    ratioMap.set(index, storedRatios[idx] ?? (1 / indices.length));
  });
  let pairRatioTotal = (ratioMap.get(beforeIndex) ?? 0) + (ratioMap.get(afterIndex) ?? 0);
  if (!Number.isFinite(pairRatioTotal) || pairRatioTotal <= 0) {
    pairRatioTotal = 1;
    ratioMap.set(beforeIndex, 0.5);
    ratioMap.set(afterIndex, 0.5);
  }

  cancelVerticalPaneDrag();

  verticalDrag = {
    pointerId: event.pointerId,
    column,
    tabId: activeTab.id,
    container: getPaneContainer(column),
    handle,
    paneOrder,
    ratios: ratioMap,
    pairRatioTotal,
    beforeIndex,
    afterIndex,
    startY: event.clientY,
    totalPixels,
    startBeforePixels: beforeRect.height,
    startAfterPixels: afterRect.height,
  };

  handle.setPointerCapture(event.pointerId);
  document.addEventListener('pointermove', handleVerticalPointerMove);
  document.addEventListener('pointerup', finishVerticalPaneResize);
  document.addEventListener('pointercancel', finishVerticalPaneResize);
  document.body.classList.add('resizing-rows');
  event.preventDefault();
  event.stopPropagation();
}

function handleVerticalPointerMove(event: PointerEvent): void {
  if (!verticalDrag || event.pointerId !== verticalDrag.pointerId) {
    return;
  }
  const { totalPixels, startBeforePixels, pairRatioTotal, beforeIndex, afterIndex } = verticalDrag;
  if (!Number.isFinite(totalPixels) || totalPixels <= 0) {
    return;
  }
  const delta = event.clientY - verticalDrag.startY;
  const rawFraction = (startBeforePixels + delta) / totalPixels;
  const clampedFraction = Math.max(
    MIN_PANE_FRACTION,
    Math.min(1 - MIN_PANE_FRACTION, rawFraction),
  );
  const beforeRatio = pairRatioTotal * clampedFraction;
  const afterRatio = pairRatioTotal - beforeRatio;
  verticalDrag.ratios.set(beforeIndex, Math.max(beforeRatio, 0.0001));
  verticalDrag.ratios.set(afterIndex, Math.max(afterRatio, 0.0001));
  const ratiosMap = verticalDrag.ratios;
  const ratios = verticalDrag.paneOrder.map((pane) => {
    const stored = ratiosMap.get(pane.descriptor.index);
    return stored ?? 0;
  });
  setPaneFlexRatios(verticalDrag.paneOrder, ratios);
  event.preventDefault();
}

function finishVerticalPaneResize(event: PointerEvent): void {
  if (!verticalDrag || event.pointerId !== verticalDrag.pointerId) {
    return;
  }
  try {
    verticalDrag.handle.releasePointerCapture(verticalDrag.pointerId);
  } catch {
    // Ignore if capture already released.
  }
  document.removeEventListener('pointermove', handleVerticalPointerMove);
  document.removeEventListener('pointerup', finishVerticalPaneResize);
  document.removeEventListener('pointercancel', finishVerticalPaneResize);
  document.body.classList.remove('resizing-rows');

  const indices = verticalDrag.paneOrder.map((pane) => pane.descriptor.index);
  const ratiosMap = verticalDrag.ratios;
  const ratios = verticalDrag.paneOrder.map((pane) => ratiosMap.get(pane.descriptor.index) ?? 0);
  setPaneRatios(verticalDrag.tabId, verticalDrag.column, indices, ratios);

  verticalDrag.paneOrder.forEach((pane) => {
    scheduleFit(pane.descriptor.index);
  });

  verticalDrag = null;
  event.preventDefault();
}

function applyPaneSizing(
  visibleByColumn: Record<PaneColumn, PaneState[]>,
): void {
  const activeTab = resolveActiveTab();

  if (verticalDrag && (!activeTab || verticalDrag.tabId !== activeTab.id)) {
    cancelVerticalPaneDrag();
  }

  if (!activeTab) {
    PANE_COLUMNS.forEach((column) => {
      latestVisiblePanesByColumn[column] = [];
      if (!verticalDrag || verticalDrag.column !== column) {
        removeColumnHandles(getPaneContainer(column));
      }
    });
    return;
  }

  PANE_COLUMNS.forEach((column) => {
    const visible = visibleByColumn[column];
    latestVisiblePanesByColumn[column] = [...visible];
    const ordered = collectOrderedPaneStates(activeTab, column, visible);
    const indices = ordered.map((pane) => pane.descriptor.index);
    prunePaneLayout(activeTab.id, column, indices);

    if (verticalDrag && verticalDrag.tabId === activeTab.id && verticalDrag.column === column) {
      const dragIndices = verticalDrag.paneOrder.map((pane) => pane.descriptor.index);
      if (dragIndices.join(',') !== indices.join(',')) {
        cancelVerticalPaneDrag();
      } else {
        const ratios = verticalDrag.paneOrder.map((pane) => verticalDrag!.ratios.get(pane.descriptor.index) ?? 0);
        setPaneFlexRatios(verticalDrag.paneOrder, ratios);
        return;
      }
    }

    if (ordered.length === 0) {
      if (!verticalDrag || verticalDrag.column !== column) {
        removeColumnHandles(getPaneContainer(column));
      }
      return;
    }

    if (ordered.length === 1) {
      setPaneFlexRatios(ordered, [1]);
      if (!verticalDrag || verticalDrag.column !== column) {
        removeColumnHandles(getPaneContainer(column));
      }
      return;
    }

    const ratios = getPaneRatios(activeTab.id, column, indices);
    setPaneFlexRatios(ordered, ratios);

    if (!verticalDrag || verticalDrag.column !== column || verticalDrag.tabId !== activeTab.id) {
      syncColumnHandles(column, ordered);
    }
  });
}

function isStackedPane(tabIndex: number, descriptorIndex: number): boolean {
  const tab = state.tabs[tabIndex];
  if (!tab) {
    return false;
  }
  const descriptor = tab.panes.find((pane) => pane.index === descriptorIndex);
  if (descriptor) {
    return descriptor.column === 'stacked';
  }
  const paneState = state.panes.get(descriptorIndex);
  return paneState?.descriptor.column === 'stacked';
}

function cancelPendingCollapse(pane?: PaneState | null): void {
  const collapseToggleId = pane?.collapseToggleId;
  if (collapseToggleId === null || collapseToggleId === undefined || !pane) {
    return;
  }
  window.clearTimeout(collapseToggleId);
  pane.collapseToggleId = null;
}

function cancelPendingCollapseByIndex(index: number): void {
  const pane = state.panes.get(index);
  cancelPendingCollapse(pane ?? null);
}

function updateCollapseControls(
  pane: PaneState,
  collapsibleOverride: boolean | null = null,
): void {
  const { container, collapseIndicator } = pane.elements;
  const collapsible =
    typeof collapsibleOverride === 'boolean'
      ? collapsibleOverride
      : isStackedPane(pane.tabIndex, pane.descriptor.index);
  const collapsed = collapsible && pane.collapsed;

  container.classList.toggle('collapsible', collapsible);
  container.classList.toggle('collapsed', collapsed);
  container.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

  if (collapseIndicator) {
    collapseIndicator.classList.toggle('hidden', !collapsible);
    collapseIndicator.disabled = !collapsible;
    collapseIndicator.setAttribute('aria-hidden', collapsible ? 'false' : 'true');
    collapseIndicator.classList.toggle('collapsed', collapsed);
    collapseIndicator.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    collapseIndicator.tabIndex = collapsible ? 0 : -1;
    const label = collapsed ? 'Expand terminal' : 'Collapse terminal';
    collapseIndicator.setAttribute('aria-label', label);
    collapseIndicator.title = label;
  }
}

function applyCollapsibleAffordances(pane: PaneState, collapsible: boolean): void {
  updateCollapseControls(pane, collapsible);
}

function setPaneCollapsed(pane: PaneState, collapsed: boolean): void {
  const collapsible = isStackedPane(pane.tabIndex, pane.descriptor.index);
  cancelPendingCollapse(pane);
  if (!collapsible) {
    if (pane.collapsed) {
      pane.collapsed = false;
    }
    updateCollapseControls(pane, false);
    if (!collapsed && pane.status === 'connected') {
      scheduleFit(pane.descriptor.index);
    }
    return;
  }

  pane.collapsed = collapsed;
  updateCollapseControls(pane, true);
  if (!collapsed && pane.status === 'connected') {
    scheduleFit(pane.descriptor.index);
  }
}

function togglePaneCollapsed(index: number): void {
  const pane = state.panes.get(index);
  if (!pane) {
    return;
  }
  if (!isStackedPane(pane.tabIndex, pane.descriptor.index)) {
    if (pane.collapsed) {
      setPaneCollapsed(pane, false);
    }
    return;
  }
  setPaneCollapsed(pane, !pane.collapsed);
}

function toggleMaximizePane(index: number): void {
  const pane = state.panes.get(index);
  if (!pane) {
    return;
  }

  const tab = state.tabs[pane.tabIndex];
  if (!tab) {
    return;
  }

  const column = pane.descriptor.column;
  const current = getMaximizedPaneIndex(tab.id, column);
  if (current === index) {
    clearMaximizedPaneIndex(tab.id, column);
  } else {
    setMaximizedPaneIndex(tab.id, column, index);
    if (column === 'stacked' && pane.collapsed) {
      setPaneCollapsed(pane, false);
    }
  }

  updateVisiblePanes();
}

function refreshPaneCollapseState(pane: PaneState): void {
  const collapsible = isStackedPane(pane.tabIndex, pane.descriptor.index);
  if (!collapsible && pane.collapsed) {
    setPaneCollapsed(pane, false);
  }
  applyCollapsibleAffordances(pane, collapsible);
}

function paneInStackedColumn(pane: PaneState): boolean {
  return pane.descriptor.column === 'stacked';
}

function updatePaneLocationActions(pane: PaneState): void {
  const workingDirectory = pane.descriptor.workingDirectory?.trim?.() ?? '';
  const title = pane.descriptor.title?.trim?.() ?? '';
  const name = title.length > 0 ? title : 'terminal';
  const cursorButton = pane.elements.openInCursorButton;
  const finderButton = pane.elements.openInFinderButton;
  const disabled = workingDirectory.length === 0;

  const editorAction = state.settings.terminalEditorAction;
  const customCommand = typeof state.settings.terminalEditorCommand === 'string'
    ? state.settings.terminalEditorCommand.trim()
    : '';

  let editorDisabled = disabled;
  let cursorLabel: string;
  switch (editorAction) {
    case 'vscode':
      cursorLabel = editorDisabled
        ? 'Open working directory in VS Code (unavailable)'
        : `Open ${name} in VS Code`;
      break;
    case 'custom':
      if (customCommand.length === 0) {
        editorDisabled = true;
        cursorLabel = 'Configure a custom command in Settings to enable this action';
      } else {
        cursorLabel = `Run custom command for ${name}`;
      }
      break;
    default:
      cursorLabel = editorDisabled
        ? 'Open working directory in Cursor (unavailable)'
        : `Open ${name} in Cursor`;
      break;
  }

  const finderLabel = disabled
    ? 'Open working directory in Finder (unavailable)'
    : `Open ${name} in Finder`;

  if (cursorButton) {
    cursorButton.disabled = editorDisabled;
    cursorButton.setAttribute('aria-disabled', editorDisabled ? 'true' : 'false');
    cursorButton.title = cursorLabel;
    cursorButton.setAttribute('aria-label', cursorLabel);
    cursorButton.classList.toggle('pane-open-button--disabled', editorDisabled);
  }

  if (finderButton) {
    finderButton.disabled = disabled;
    finderButton.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    finderButton.title = finderLabel;
    finderButton.setAttribute('aria-label', finderLabel);
    finderButton.classList.toggle('pane-open-button--disabled', disabled);
  }
}

export function refreshPaneLocationActions(pane: PaneState): void {
  updatePaneLocationActions(pane);
}

export function syncMiddleColumnTerminals(): void {
  const action = state.settings.terminalCloudAction;
  const requiresGitHub = action !== 'customScript';
  const scriptConfigured = action !== 'customScript'
    || (typeof state.settings.terminalCloudCustomScript === 'string'
      && state.settings.terminalCloudCustomScript.trim().length > 0);

  if ((requiresGitHub && !state.settings.githubAccountConnected) || !scriptConfigured) {
    return;
  }
  if (!state.columnLayout.visibility.stacked) {
    return;
  }

  const activeTabIndex = state.activeTabIndex;
  const synced = new Set<number>();

  state.panes.forEach((pane) => {
    if (pane.tabIndex !== activeTabIndex) {
      return;
    }
    if (pane.status !== 'connected') {
      return;
    }
    if (!paneInStackedColumn(pane)) {
      return;
    }

    const index = pane.descriptor.index;
    if (synced.has(index)) {
      return;
    }
    synced.add(index);
    notifyNative('gitSync', { index });
  });
}

export function undoMiddleColumnTerminals(): void {
  if (!state.settings.githubAccountConnected) {
    return;
  }
  if (!state.columnLayout.visibility.stacked) {
    return;
  }

  const activeTabIndex = state.activeTabIndex;
  const undone = new Set<number>();

  state.panes.forEach((pane) => {
    if (pane.tabIndex !== activeTabIndex) {
      return;
    }
    if (pane.status !== 'connected') {
      return;
    }
    if (!paneInStackedColumn(pane)) {
      return;
    }

    const index = pane.descriptor.index;
    if (undone.has(index)) {
      return;
    }
    undone.add(index);
    notifyNative('gitUndo', { index });
  });
}

function renderPaneGitStatus(pane: PaneState): void {
  const container = pane.elements.gitStatusContainer;
  const addition = pane.elements.gitAdditionCount;
  const deletion = pane.elements.gitDeletionCount;
  const syncButton = pane.elements.gitSyncButton;
  const undoButton = pane.elements.gitUndoButton;
  const summary = pane.elements.gitSummary;
  if (!container || !addition || !deletion || !syncButton) {
    return;
  }

  const status = pane.gitStatus;
  const isStacked = paneInStackedColumn(pane);
  const action = state.settings.terminalCloudAction;
  const requiresGitHub = action !== 'customScript';
  const scriptText = typeof state.settings.terminalCloudCustomScript === 'string'
    ? state.settings.terminalCloudCustomScript.trim()
    : '';
  const scriptConfigured = action !== 'customScript' || scriptText.length > 0;
  const defaultTooltip = action === 'createPullRequest'
    ? 'Create pull request'
    : action === 'customScript'
      ? 'Run custom script'
      : 'Commit and push pending changes';
  const loginTooltip = 'Sign in with the GitHub CLI to sync changes';
  const configurationTooltip = 'Configure a custom script in Settings to enable this action';
  const undoTooltip = 'Reset repository to HEAD and delete untracked files and folders';
  const connected = state.settings.githubAccountConnected;

  if (!status || !status.isRepository || !isStacked) {
    container.classList.add('hidden');
    container.removeAttribute('data-syncing');
    container.removeAttribute('data-has-changes');
    container.removeAttribute('data-error');
    syncButton.disabled = true;
    syncButton.classList.remove('syncing');
    if (!syncButton.firstElementChild) {
      syncButton.textContent = '⟳';
    }
    const idleTooltip = !scriptConfigured
      ? configurationTooltip
      : (requiresGitHub && !connected ? loginTooltip : defaultTooltip);
    syncButton.setAttribute('aria-label', idleTooltip);
    syncButton.title = idleTooltip;
    container.title = idleTooltip;
    syncButton.classList.remove('requires-auth');
    syncButton.classList.toggle('requires-config', !scriptConfigured);
    if (undoButton) {
      undoButton.classList.add('hidden');
      undoButton.disabled = false;
    }
    if (summary) {
      summary.classList.remove('git-summary-interactive');
      summary.setAttribute('aria-disabled', 'true');
    }
    return;
  }

  container.classList.remove('hidden');

  const insertions = Math.max(0, status.insertions ?? 0);
  const deletions = Math.max(0, status.deletions ?? 0);
  const changeCount = Math.max(0, status.changedFiles ?? 0);
  const hasLineChanges = insertions > 0 || deletions > 0;
  const hasAnyChanges = hasLineChanges || changeCount > 0;

  const hideForNoChanges = action !== 'customScript'
    && !hasAnyChanges
    && !status.syncing
    && !(typeof status.error === 'string' && status.error.length > 0);

  if (hideForNoChanges) {
    container.classList.add('hidden');
    container.removeAttribute('data-syncing');
    container.removeAttribute('data-has-changes');
    container.removeAttribute('data-error');
    const disabledForAuth = requiresGitHub && !connected;
    const disabledForConfig = !scriptConfigured;
    syncButton.disabled = disabledForAuth || disabledForConfig;
    syncButton.classList.remove('syncing');
    if (!syncButton.firstElementChild) {
      syncButton.textContent = '⟳';
    }
    const idleTooltip = disabledForConfig
      ? configurationTooltip
      : (disabledForAuth ? loginTooltip : defaultTooltip);
    syncButton.setAttribute('aria-label', idleTooltip);
    syncButton.title = idleTooltip;
    container.title = idleTooltip;
    syncButton.classList.toggle('requires-auth', disabledForAuth);
    syncButton.classList.toggle('requires-config', disabledForConfig);
    if (undoButton) {
      undoButton.classList.add('hidden');
      undoButton.disabled = false;
    }
    if (summary) {
      summary.classList.remove('git-summary-interactive');
      summary.setAttribute('aria-disabled', 'true');
    }
    return;
  }

  if (hasLineChanges) {
    addition.textContent = `+${insertions}`;
    addition.classList.add('git-additions');
    addition.classList.remove('git-files');
    deletion.classList.remove('hidden');
    deletion.classList.add('git-deletions');
    deletion.textContent = `-${deletions}`;
  } else if (changeCount > 0) {
    addition.textContent = `±${changeCount} ${changeCount === 1 ? 'file' : 'files'}`;
    addition.classList.remove('git-additions');
    addition.classList.add('git-files');
    deletion.classList.add('hidden');
    deletion.classList.remove('git-deletions');
    deletion.textContent = '';
  } else {
    addition.textContent = '+0';
    addition.classList.add('git-additions');
    addition.classList.remove('git-files');
    deletion.classList.remove('hidden');
    deletion.classList.add('git-deletions');
    deletion.textContent = '-0';
  }

  const hasError = typeof status.error === 'string' && status.error.length > 0;
  const tooltip = hasError
    ? (status.error ?? defaultTooltip)
    : status.syncing
      ? (action === 'customScript' ? 'Running custom script…' : 'Syncing changes…')
      : (changeCount > 0
        ? `${changeCount} pending ${changeCount === 1 ? 'file' : 'files'}`
        : defaultTooltip);

  container.dataset['hasChanges'] = hasAnyChanges ? 'true' : 'false';
  container.dataset['syncing'] = status.syncing ? 'true' : 'false';
  container.dataset['error'] = status.error && status.error.length > 0 ? 'true' : 'false';
  const disabledForAuth = requiresGitHub && !connected;
  const disabledForConfig = !scriptConfigured;
  const buttonTooltip = disabledForConfig
    ? configurationTooltip
    : (disabledForAuth ? loginTooltip : tooltip);
  syncButton.disabled = status.syncing || disabledForAuth || disabledForConfig;
  syncButton.classList.toggle('syncing', status.syncing);
  syncButton.classList.toggle('requires-auth', disabledForAuth);
  syncButton.classList.toggle('requires-config', disabledForConfig);
  if (!syncButton.firstElementChild) {
    syncButton.textContent = '⟳';
  }
  syncButton.setAttribute('aria-label', buttonTooltip);
  syncButton.title = buttonTooltip;
  container.title = hasError ? tooltip : buttonTooltip;

  if (undoButton) {
    undoButton.classList.toggle('hidden', !hasAnyChanges);
    undoButton.disabled = status.syncing;
    undoButton.setAttribute('aria-label', undoTooltip);
    undoButton.title = undoTooltip;
  }

  if (summary) {
    summary.classList.toggle('git-summary-interactive', hasAnyChanges);
    summary.setAttribute('aria-disabled', hasAnyChanges ? 'false' : 'true');
  }
}

function paneStatusMessage(status: PaneStatus): string {
  switch (status) {
    case 'connected':
      return '';
    case 'connecting':
      return 'Connecting…';
    default:
      return 'Terminal disconnected';
  }
}

function updatePlaceholder(pane: PaneState, status: PaneStatus): void {
  const { placeholder, message, reconnectButton } = pane.elements;
  message.textContent = paneStatusMessage(status);
  if (status === 'disconnected') {
    reconnectButton.classList.remove('hidden');
  } else {
    reconnectButton.classList.add('hidden');
  }
  if (status === 'connected') {
    placeholder.classList.add('hidden');
  } else {
    placeholder.classList.remove('hidden');
  }
}

export function setPaneStatus(index: number, status: PaneStatus): void {
  const pane = state.panes.get(index);
  if (!pane) {
    return;
  }
  pane.status = status;
  pane.descriptor.status = status;

  const tab = state.tabs[pane.tabIndex];
  if (tab) {
    const tabPane = tab.panes.find((p) => p.index === index);
    if (tabPane) {
      tabPane.status = status;
    }
  }

  if (status !== 'connected') {
    resetPaneActivity(index);
  }

  if (status === 'connected') {
    pane.elements.terminalContainer.classList.remove('hidden');
    const term = ensureTerminal(index);
    if (term) {
      pane.terminal = term;
      flushPendingPayload(index, term);
    }
    updatePlaceholder(pane, status);
    if (!pane.collapsed) {
      scheduleFit(index);
    }
  } else if (status === 'connecting') {
    disposeTerminal(index);
    pane.elements.terminalContainer.classList.add('hidden');
    updatePlaceholder(pane, status);
  } else {
    updatePlaceholder(pane, status);
    disposeTerminal(index);
    pane.elements.terminalContainer.classList.add('hidden');
  }

  if (pane.descriptor.column === 'primary') {
    const tabIdForPane = tab?.id ?? null;
    syncPaneActivityIndicatorWithStatus(index, tabIdForPane, status);
    if (pane.tabIndex === state.activeTabIndex) {
      const activeTab = resolveActiveTab();
      const activeTabId = activeTab?.id ?? null;
      const activeMaximizedByColumn = activeTabId
        ? state.maximizedPaneByTab.get(activeTabId) ?? {}
        : {};
      renderPrimaryAgentSwitcher(activeTab, activeMaximizedByColumn);
    }
  }
}

function normaliseGitHubActionState(raw: unknown): 'unknown' | 'success' | 'failure' | 'inProgress' {
  if (typeof raw !== 'string') {
    return 'unknown';
  }
  const value = raw.trim().toLowerCase();
  if (value === 'success' || value === 'succeeded' || value === 'passed') {
    return 'success';
  }
  if (value === 'inprogress' || value === 'in_progress' || value === 'running' || value === 'queued' || value === 'waiting') {
    return 'inProgress';
  }
  const failureStates = new Set(['failure', 'failed', 'cancelled', 'canceled', 'timed_out', 'timed-out', 'action_required', 'stopped']);
  if (failureStates.has(value)) {
    return 'failure';
  }
  return 'unknown';
}

function normaliseGitHubActionStatus(status: PaneGitHubActionStatus): PaneGitHubActionStatus {
  const deriveNumber = (input: unknown): number | null => {
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
  const jobs: PaneGitHubActionStatus['jobs'] = Array.isArray(status.jobs)
    ? status.jobs.flatMap((job) => {
      if (!job || typeof job !== 'object') {
        return [];
      }
      const steps = Array.isArray(job.steps)
        ? job.steps.flatMap((step) => {
          if (!step || typeof step !== 'object') {
            return [];
          }
          const number = deriveNumber(step.number);
          const rawLog = typeof step.log === 'string' ? step.log : undefined;
          const log = rawLog && rawLog.trim().length > 0 ? rawLog : undefined;
          return [{
            name: typeof step.name === 'string' ? step.name : undefined,
            status: typeof step.status === 'string' ? step.status : undefined,
            conclusion: typeof step.conclusion === 'string' ? step.conclusion : undefined,
            number,
            log,
          }];
        })
        : [];
      return [{
        id: deriveNumber(job?.id),
        name: typeof job.name === 'string' ? job.name : undefined,
        status: typeof job.status === 'string' ? job.status : undefined,
        conclusion: typeof job.conclusion === 'string' ? job.conclusion : undefined,
        htmlURL: typeof job.htmlURL === 'string' ? job.htmlURL : undefined,
        startedAt: typeof job.startedAt === 'string' ? job.startedAt : undefined,
        completedAt: typeof job.completedAt === 'string' ? job.completedAt : undefined,
        steps,
      }];
    })
    : [];

  return {
    state: normaliseGitHubActionState(status.state),
    runId: deriveNumber(status.runId),
    workflowName: typeof status.workflowName === 'string' ? status.workflowName : undefined,
    displayTitle: typeof status.displayTitle === 'string' ? status.displayTitle : undefined,
    status: typeof status.status === 'string' ? status.status : undefined,
    conclusion: typeof status.conclusion === 'string' ? status.conclusion : undefined,
    headBranch: typeof status.headBranch === 'string' ? status.headBranch : undefined,
    headSha: typeof status.headSha === 'string' ? status.headSha : undefined,
    htmlURL: typeof status.htmlURL === 'string' ? status.htmlURL : undefined,
    event: typeof status.event === 'string' ? status.event : undefined,
    createdAt: typeof status.createdAt === 'string' ? status.createdAt : undefined,
    updatedAt: typeof status.updatedAt === 'string' ? status.updatedAt : undefined,
    startedAt: typeof status.startedAt === 'string' ? status.startedAt : undefined,
    completedAt: typeof status.completedAt === 'string' ? status.completedAt : undefined,
    jobs,
    error: typeof status.error === 'string' ? status.error : undefined,
  };
}

function deriveGitHubRunKey(status: PaneGitHubActionStatus): string {
  if (typeof status.runId === 'number' && Number.isFinite(status.runId)) {
    return `id:${status.runId}`;
  }
  if (typeof status.headSha === 'string' && status.headSha.trim().length > 0) {
    return `sha:${status.headSha.trim()}`;
  }
  if (typeof status.completedAt === 'string' && status.completedAt.trim().length > 0) {
    return `completed:${status.completedAt.trim()}`;
  }
  if (typeof status.startedAt === 'string' && status.startedAt.trim().length > 0) {
    return `started:${status.startedAt.trim()}`;
  }
  if (typeof status.htmlURL === 'string' && status.htmlURL.trim().length > 0) {
    return `url:${status.htmlURL.trim()}`;
  }
  if (typeof status.error === 'string' && status.error.trim().length > 0) {
    const trimmed = status.error.trim();
    return `error:${trimmed.slice(0, 64)}`;
  }
  return 'unknown-run';
}

function openGitHubActionDetails(pane: PaneState): void {
  const status = pane.githubActionStatus;
  if (!status) {
    return;
  }
  showGitHubActionModal(pane, status);
  const runKey = deriveGitHubRunKey(status);
  pane.lastGitHubActionModalRunId = runKey;
}

function renderPaneGitHubActionStatus(pane: PaneState): void {
  const indicator = pane.elements.githubIndicator;
  if (!indicator) {
    return;
  }

  const status = pane.githubActionStatus;
  if (!status || pane.descriptor.column !== 'stacked') {
    indicator.classList.add('hidden');
    indicator.removeAttribute('data-state');
    indicator.removeAttribute('title');
    indicator.removeAttribute('aria-label');
    indicator.setAttribute('aria-hidden', 'true');
    indicator.removeAttribute('role');
    indicator.removeAttribute('tabindex');
    indicator.tabIndex = -1;
    pane.lastGitHubActionModalRunId = null;
    return;
  }

  indicator.classList.add('pane-github-indicator');
  indicator.classList.remove('hidden');
  indicator.classList.remove(...GITHUB_INDICATOR_CLASSES);
  indicator.setAttribute('aria-hidden', 'false');
  indicator.setAttribute('role', 'button');
  indicator.tabIndex = 0;

  const state = normaliseGitHubActionState(status.state);
  let className = 'pane-github-indicator--unknown';
  if (state === 'success') {
    className = 'pane-github-indicator--success';
  } else if (state === 'failure') {
    className = 'pane-github-indicator--failure';
  } else if (state === 'inProgress') {
    className = 'pane-github-indicator--progress';
  }
  indicator.classList.add(className);
  indicator.dataset['state'] = state;

  const label = typeof status.displayTitle === 'string' && status.displayTitle.trim().length > 0
    ? status.displayTitle.trim()
    : typeof status.workflowName === 'string' && status.workflowName.trim().length > 0
      ? status.workflowName.trim()
      : 'Workflow';
  const labelParts: string[] = [label];
  if (state === 'success') {
    labelParts.push('Passed');
  } else if (state === 'failure') {
    labelParts.push('Failed');
  } else if (state === 'inProgress') {
    labelParts.push('In progress');
  }
  if (typeof status.headBranch === 'string' && status.headBranch.trim().length > 0) {
    labelParts.push(`Branch ${status.headBranch.trim()}`);
  }
  if (typeof status.event === 'string' && status.event.trim().length > 0) {
    labelParts.push(status.event.trim());
  }
  let tooltip = labelParts.join(' — ');
  if (typeof status.error === 'string' && status.error.trim().length > 0) {
    tooltip = status.error.trim();
  }
  indicator.title = tooltip;
  indicator.setAttribute('aria-label', tooltip);

  if (state !== 'failure') {
    pane.lastGitHubActionModalRunId = null;
  }
}

export function updatePaneGitHubActionStatus(index: number, status: PaneGitHubActionStatus): void {
  const normalised = normaliseGitHubActionStatus(status);
  const pane = state.panes.get(index);
  if (!pane) {
    state.pendingGitHubActionStatuses.set(index, normalised);
    return;
  }
  pane.githubActionStatus = normalised;
  renderPaneGitHubActionStatus(pane);
  state.pendingGitHubActionStatuses.delete(index);
}

export function updatePaneGitStatus(index: number, status: PaneGitStatus): void {
  const pane = state.panes.get(index);
  if (!pane) {
    state.pendingGitStatuses.set(index, { ...status });
    return;
  }
  pane.gitStatus = { ...status };
  state.pendingGitStatuses.delete(index);
  renderPaneGitStatus(pane);
}

export function refreshAllPaneGitStatus(): void {
  state.panes.forEach((pane) => {
    renderPaneGitStatus(pane);
    renderPaneGitHubActionStatus(pane);
  });
}

function requestRemovePane(index: number): void {
  notifyNative('removePane', { index });
}

function requestRespawnPane(index: number): void {
  notifyNative('respawnPane', { index });
}

function requestReconnectPane(index: number): void {
  notifyNative('reconnectPane', { index });
}

function requestPaneUpdate(index: number): void {
  const pane = state.panes.get(index);
  if (!pane) {
    return;
  }
  const commandValue = pane.descriptor.startupCommand?.trim?.() ?? '';
  const workingDirectory = pane.descriptor.workingDirectory?.trim?.() ?? '';
  notifyNative('updatePane', {
    index,
    title: pane.descriptor.title,
    workingDirectory,
    startupCommand: commandValue.length > 0 ? commandValue : null,
  });
}

export interface AddPaneOptions {
  title?: string;
  startupCommand?: string;
  workingDirectory?: string;
}

export function requestAddPane(column: 'primary' | 'stacked', options: AddPaneOptions = {}): void {
  const activeTab = state.tabs[state.activeTabIndex];
  const payload: Record<string, unknown> = {
    column,
    tabId: activeTab?.id,
    tabIndex: state.activeTabIndex,
  };
  if (options.title && options.title.trim().length > 0) {
    payload['title'] = options.title.trim();
  }
  if (options.startupCommand && options.startupCommand.trim().length > 0) {
    payload['startupCommand'] = options.startupCommand;
  }
  if (options.workingDirectory && options.workingDirectory.trim().length > 0) {
    payload['workingDirectory'] = options.workingDirectory;
  }
  notifyNative('addPane', payload);
}

function finishPaneRename(index: number, input: HTMLInputElement, commit: boolean): void {
  const pane = state.panes.get(index);
  const titleElement = pane?.elements.title ?? null;
  if (!pane || !titleElement) {
    input.remove();
    return;
  }
  const wasEditing = titleElement.dataset['editing'] === 'true';
  titleElement.dataset['editing'] = 'false';
  const trimmed = input.value.trim();
  input.replaceWith(titleElement);

  if (!wasEditing) {
    titleElement.textContent = pane.descriptor.title;
    titleElement.title = `${pane.descriptor.title} — double-click to rename`;
    return;
  }

  if (commit && trimmed && trimmed !== pane.descriptor.title) {
    const resolved = normalisePaneTitle(index, trimmed, pane.descriptor.workingDirectory);
    pane.descriptor.title = resolved;
    titleElement.textContent = resolved;
    titleElement.title = `${resolved} — double-click to rename`;
    const tab = state.tabs[pane.tabIndex];
    if (tab) {
      const paneDescriptor = tab.panes.find((candidate) => candidate.index === index);
      if (paneDescriptor) {
        paneDescriptor.title = resolved;
      }
    }
    notifyNative('renamePane', { index, title: resolved });
  } else {
    titleElement.textContent = pane.descriptor.title;
    titleElement.title = `${pane.descriptor.title} — double-click to rename`;
  }

  updatePaneLocationActions(pane);
  if (pane.descriptor.column === 'primary' && pane.tabIndex === state.activeTabIndex) {
    updateVisiblePanes();
  }
}

function beginRenamePane(index: number): void {
  const pane = state.panes.get(index);
  if (!pane) {
    return;
  }
  const titleElement = pane.elements.title;
  if (titleElement.dataset['editing'] === 'true') {
    return;
  }
  titleElement.dataset['editing'] = 'true';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-rename-input';
  input.value = pane.descriptor.title;
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finishPaneRename(index, input, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishPaneRename(index, input, false);
    }
  });
  input.addEventListener('blur', () => finishPaneRename(index, input, true));
  titleElement.replaceWith(input);
  input.focus();
  input.select();
}

export function createPane(tabIndex: number, rawDescriptor: unknown): void {
  const descriptor = normalisePaneDescriptor(rawDescriptor);
  if (!descriptor) {
    return;
  }

  const container = document.createElement('div');
  container.className = 'pane';
  container.dataset['tabIndex'] = String(tabIndex);
  container.dataset['paneIndex'] = String(descriptor.index);
  container.dataset['paneId'] = descriptor.id;
  container.dataset['column'] = descriptor.column;
  container.setAttribute('aria-expanded', 'true');

  const header = document.createElement('header');
  const indicator = document.createElement('button');
  indicator.type = 'button';
  indicator.className = 'collapse-indicator hidden';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.setAttribute('aria-expanded', 'true');
  const indicatorIcon = createIcon('chevronDown');
  if (indicatorIcon) {
    indicator.appendChild(indicatorIcon);
  } else {
    indicator.textContent = '▾';
  }
  indicator.addEventListener('click', (event) => {
    event.stopPropagation();
    togglePaneCollapsed(descriptor.index);
  });

  const titleGroup = document.createElement('div');
  titleGroup.className = 'pane-title-group';
  titleGroup.appendChild(indicator);
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = descriptor.title;
  title.title = `${descriptor.title} — double-click to rename`;
  title.setAttribute('role', 'button');
  title.setAttribute('tabindex', '0');
  title.addEventListener('dblclick', (event) => {
    cancelPendingCollapseByIndex(descriptor.index);
    event.stopPropagation();
    beginRenamePane(descriptor.index);
  });
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      beginRenamePane(descriptor.index);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      event.stopPropagation();
      requestPaneUpdate(descriptor.index);
    }
  });
  titleGroup.appendChild(title);
  let githubIndicator: HTMLSpanElement | null = null;
  if (descriptor.column === 'stacked') {
    githubIndicator = document.createElement('span');
    githubIndicator.className = 'pane-github-indicator hidden';
    githubIndicator.setAttribute('aria-hidden', 'true');
    githubIndicator.addEventListener('click', (event) => {
      event.stopPropagation();
      const paneState = state.panes.get(descriptor.index);
      if (paneState) {
        openGitHubActionDetails(paneState);
      }
    });
    githubIndicator.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        const paneState = state.panes.get(descriptor.index);
        if (paneState) {
          openGitHubActionDetails(paneState);
        }
      }
    });
    titleGroup.appendChild(githubIndicator);
  }
  header.appendChild(titleGroup);
  header.addEventListener('contextmenu', (event) => {
    showContextMenu(event, [
      {
        label: 'Copy Path',
        action: () => copyPaneWorkingDirectory(descriptor.index),
      },
    ]);
  });
  if (descriptor.column === 'primary') {
    header.addEventListener('mousedown', () => {
      focusPrimaryPane(descriptor.index, { focusTerminal: false });
    });
  }
  const gitStatusContainer = document.createElement('div');
  gitStatusContainer.className = 'pane-git-info hidden';
  gitStatusContainer.setAttribute('aria-live', 'polite');

  const gitSummary = document.createElement('span');
  gitSummary.className = 'git-summary';
  const gitAdditionCount = document.createElement('span');
  gitAdditionCount.className = 'git-count git-additions';
  gitAdditionCount.textContent = '+0';
  const gitDeletionCount = document.createElement('span');
  gitDeletionCount.className = 'git-count git-deletions';
  gitDeletionCount.textContent = '-0';
  gitSummary.appendChild(gitAdditionCount);
  gitSummary.appendChild(document.createTextNode(' '));
  gitSummary.appendChild(gitDeletionCount);
  gitStatusContainer.appendChild(gitSummary);

  gitSummary.setAttribute('role', 'button');
  gitSummary.tabIndex = 0;
  gitSummary.addEventListener('click', (event) => {
    const host = gitSummary.closest<HTMLElement>('.pane-git-info');
    if (host?.dataset['hasChanges'] !== 'true') {
      return;
    }
    event.stopPropagation();
    openGitDetailsModal(descriptor.index);
  });
  gitSummary.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      const host = gitSummary.closest<HTMLElement>('.pane-git-info');
      if (host?.dataset['hasChanges'] !== 'true') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openGitDetailsModal(descriptor.index);
    }
  });

  const gitUndoButton = document.createElement('button');
  gitUndoButton.type = 'button';
  gitUndoButton.className = 'pane-action git-undo-button hidden';
  const gitUndoIcon = createIcon('undo');
  if (gitUndoIcon) {
    gitUndoButton.appendChild(gitUndoIcon);
  }
  gitUndoButton.setAttribute('aria-label', 'Reset repository to HEAD and delete untracked files and folders');
  gitUndoButton.title = 'Reset repository to HEAD and delete untracked files and folders';
  gitUndoButton.addEventListener('click', (event) => {
    void (async () => {
      event.stopPropagation();
      const paneState = state.panes.get(descriptor.index);
      const paneTitle = paneState?.descriptor.title ?? descriptor.title;
      const trimmedTitle = paneTitle?.trim?.() ?? '';
      const targetLabel = trimmedTitle.length > 0 ? `"${trimmedTitle}"` : 'this terminal';
      const confirmed = await confirmAction({
        title: 'Reset Repository',
        message: `Reset ${targetLabel} to HEAD and delete untracked files and folders?`,
        confirmLabel: 'Reset & Delete',
        cancelLabel: 'Cancel',
        dangerous: true,
      });
      if (!confirmed) {
        return;
      }
      notifyNative('gitUndo', { index: descriptor.index });
    })();
  });
  gitStatusContainer.appendChild(gitUndoButton);

  const gitSyncButton = document.createElement('button');
  gitSyncButton.type = 'button';
  gitSyncButton.className = 'pane-action git-sync-button';
  const gitSyncIcon = createIcon('gitPush');
  if (gitSyncIcon) {
    gitSyncButton.appendChild(gitSyncIcon);
  }
  gitSyncButton.title = 'Commit and push pending changes';
  gitSyncButton.setAttribute('aria-label', 'Commit and push pending changes');
  gitSyncButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!state.settings.githubAccountConnected) {
      promptGitHubSignIn();
      return;
    }
    notifyNative('gitSync', { index: descriptor.index });
  });
  gitStatusContainer.appendChild(gitSyncButton);

  header.appendChild(gitStatusContainer);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const maximizeButton = document.createElement('button');
  maximizeButton.type = 'button';
  maximizeButton.className = 'pane-action pane-maximize-button';
  const maximizeIcon = createIcon('maximize');
  if (maximizeIcon) {
    maximizeButton.appendChild(maximizeIcon);
  } else {
    maximizeButton.textContent = '⤢';
  }
  maximizeButton.title = 'Maximize terminal';
  maximizeButton.setAttribute('aria-label', 'Maximize terminal');
  maximizeButton.setAttribute('aria-pressed', 'false');
  maximizeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMaximizePane(descriptor.index);
  });
  actions.appendChild(maximizeButton);

  const openInCursorButton = document.createElement('button');
  openInCursorButton.type = 'button';
  openInCursorButton.className = 'pane-action pane-open-button pane-open-cursor-button';
  const openInCursorIcon = createIcon('openInCursor');
  if (openInCursorIcon) {
    openInCursorButton.appendChild(openInCursorIcon);
  }
  openInCursorButton.title = 'Open in Cursor';
  openInCursorButton.setAttribute('aria-label', 'Open in Cursor');
  openInCursorButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const paneState = state.panes.get(descriptor.index);
    const workingDirectory = paneState?.descriptor?.workingDirectory?.trim?.() ?? '';
    if (!workingDirectory) {
      return;
    }
    notifyNative('openInCursor', { index: descriptor.index });
  });
  actions.appendChild(openInCursorButton);

  const openInFinderButton = document.createElement('button');
  openInFinderButton.type = 'button';
  openInFinderButton.className = 'pane-action pane-open-button pane-open-finder-button';
  const openInFinderIcon = createIcon('openInFinder');
  if (openInFinderIcon) {
    openInFinderButton.appendChild(openInFinderIcon);
  }
  openInFinderButton.title = 'Open in Finder';
  openInFinderButton.setAttribute('aria-label', 'Open in Finder');
  openInFinderButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const paneState = state.panes.get(descriptor.index);
    const workingDirectory = paneState?.descriptor?.workingDirectory?.trim?.() ?? '';
    if (!workingDirectory) {
      return;
    }
    notifyNative('openInFinder', { index: descriptor.index });
  });
  actions.appendChild(openInFinderButton);

  const respawnButton = document.createElement('button');
  respawnButton.type = 'button';
  respawnButton.className = 'pane-action pane-respawn-button';
  const respawnIcon = createIcon('refresh');
  if (respawnIcon) {
    respawnButton.appendChild(respawnIcon);
  }
  respawnButton.title = 'Respawn terminal';
  respawnButton.setAttribute('aria-label', 'Respawn terminal');
  respawnButton.addEventListener('click', (event) => {
    event.stopPropagation();
    requestRespawnPane(descriptor.index);
  });
  actions.appendChild(respawnButton);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'pane-action pane-close-button';
  closeButton.title = 'Remove terminal';
  closeButton.setAttribute('aria-label', 'Remove terminal');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    requestRemovePane(descriptor.index);
  });
  actions.appendChild(closeButton);

  header.appendChild(actions);

  container.appendChild(header);

  const placeholder = document.createElement('div');
  placeholder.className = 'pane-placeholder hidden';
  const message = document.createElement('div');
  message.className = 'message';
  placeholder.appendChild(message);
  const reconnectButton = document.createElement('button');
  reconnectButton.type = 'button';
  reconnectButton.className = 'pane-button';
  reconnectButton.textContent = 'Reconnect';
  reconnectButton.addEventListener('click', () => requestReconnectPane(descriptor.index));
  placeholder.appendChild(reconnectButton);

  const terminalContainer = document.createElement('div');
  terminalContainer.className = 'terminal hidden';
  terminalContainer.dataset['paneIndex'] = String(descriptor.index);
  if (descriptor.column === 'primary') {
    terminalContainer.addEventListener('mousedown', () => {
      focusPrimaryPane(descriptor.index, { focusTerminal: false });
    });
  }

  container.appendChild(placeholder);
  container.appendChild(terminalContainer);

  const host = resolvePaneHost(tabIndex, descriptor.index);
  host.appendChild(container);

  const paneState: PaneState = {
    tabIndex,
    descriptor: { ...descriptor },
    elements: {
      container,
      header,
      title,
      githubIndicator: githubIndicator ?? undefined,
      collapseIndicator: indicator,
      maximizeButton,
      gitStatusContainer,
      gitSummary,
      gitAdditionCount,
      gitDeletionCount,
      gitSyncButton,
      gitUndoButton,
      openInCursorButton,
      openInFinderButton,
      terminalContainer,
      placeholder,
      message,
      reconnectButton,
      actions,
    },
    terminal: null,
    status: descriptor.status,
    collapsed: false,
    collapseToggleId: null,
    gitStatus: undefined,
    githubActionStatus: undefined,
    lastGitHubActionModalRunId: null,
  };

  const pendingGitStatus = state.pendingGitStatuses.get(descriptor.index);
  if (pendingGitStatus) {
    paneState.gitStatus = { ...pendingGitStatus };
    state.pendingGitStatuses.delete(descriptor.index);
  }

  const pendingGitHubStatus = state.pendingGitHubActionStatuses.get(descriptor.index);
  if (pendingGitHubStatus) {
    paneState.githubActionStatus = {
      ...pendingGitHubStatus,
      jobs: Array.isArray(pendingGitHubStatus.jobs) ? [...pendingGitHubStatus.jobs] : [],
    };
    state.pendingGitHubActionStatuses.delete(descriptor.index);
  }

  updatePaneLocationActions(paneState);
  state.panes.set(descriptor.index, paneState);
  if (descriptor.column === 'primary') {
    const tabId = state.tabs[tabIndex]?.id ?? null;
    if (tabId) {
      setFocusedPrimaryPaneIndex(tabId, descriptor.index);
    }
  }
  const tabForIndicator = state.tabs[tabIndex];
  if (descriptor.column === 'primary') {
    registerPaneActivityIndicator(
      descriptor.index,
      tabForIndicator?.id ?? null,
      header,
      descriptor.status,
    );
  } else {
    unregisterPaneActivityIndicator(descriptor.index);
  }
  if (descriptor.column === 'stacked') {
    attachPaneCommandControls(paneState);
    attachPaneLinkControls(paneState);
  }
  refreshPaneCollapseState(paneState);
  renderPaneGitStatus(paneState);
  renderPaneGitHubActionStatus(paneState);
  setPaneStatus(descriptor.index, descriptor.status);
  observePaneContainer(terminalContainer, descriptor.index);
}

export function updateVisiblePanes(): void {
  reflowPaneHosts();

  const visibleByColumn: Record<PaneColumn, PaneState[]> = {
    primary: [],
    stacked: [],
  };

  const activeTab = state.tabs[state.activeTabIndex];
  const activeTabId = activeTab?.id ?? null;
  const activeMaximizedByColumn: Partial<Record<PaneColumn, number>> = activeTabId
    ? state.maximizedPaneByTab.get(activeTabId) ?? {}
    : {};
  const primaryMaximizedIndexRaw = activeMaximizedByColumn.primary;
  const primaryMaximizedIndex =
    typeof primaryMaximizedIndexRaw === 'number' ? primaryMaximizedIndexRaw : null;
  const primaryFocusMode = shouldUsePrimaryAgentSwitcher(activeTab ?? null, primaryMaximizedIndex);
  const focusedPrimaryPaneIndex = primaryFocusMode ? resolveFocusedPrimaryPaneIndex(activeTab ?? null) : null;

  state.panes.forEach((pane) => {
    refreshPaneCollapseState(pane);
    renderPaneGitStatus(pane);

    const isActiveTab = pane.tabIndex === state.activeTabIndex;
    const column = pane.descriptor.column;
    const columnMaximizedIndexRaw = activeMaximizedByColumn[column];
    const columnMaximizedIndex =
      typeof columnMaximizedIndexRaw === 'number' ? columnMaximizedIndexRaw : null;
    const isMaximized =
      isActiveTab && columnMaximizedIndex !== null && columnMaximizedIndex === pane.descriptor.index;
    const hiddenByMaximize =
      isActiveTab
      && columnMaximizedIndex !== null
      && columnMaximizedIndex !== pane.descriptor.index;
    const hiddenByPrimaryFocus =
      isActiveTab
      && primaryFocusMode
      && column === 'primary'
      && focusedPrimaryPaneIndex !== null
      && focusedPrimaryPaneIndex !== pane.descriptor.index;
    const shouldBeVisible = isActiveTab && !hiddenByMaximize && !hiddenByPrimaryFocus;

    const { container, terminalContainer, maximizeButton } = pane.elements;

    if (shouldBeVisible) {
      container.classList.remove('tab-hidden');
      container.classList.remove('pane-maximized-hidden');
      container.classList.remove('pane-primary-focused-hidden');
      container.classList.toggle('pane-maximized', isMaximized);
      container.removeAttribute('aria-hidden');

      visibleByColumn[pane.descriptor.column].push(pane);
      if (pane.descriptor.column === 'primary') {
        clearUnreadPrimaryOutput(pane.descriptor.index);
      }

      if (pane.status === 'connected') {
        terminalContainer.classList.remove('hidden');
        if (!pane.collapsed) {
          scheduleFit(pane.descriptor.index);
        }
      } else {
        terminalContainer.classList.add('hidden');
      }
    } else {
      if (!isActiveTab) {
        container.classList.add('tab-hidden');
      } else {
        container.classList.remove('tab-hidden');
      }
      container.classList.remove('pane-maximized');
      container.classList.toggle('pane-maximized-hidden', hiddenByMaximize);
      container.classList.toggle('pane-primary-focused-hidden', hiddenByPrimaryFocus);
      if (!isActiveTab || hiddenByMaximize || hiddenByPrimaryFocus) {
        container.setAttribute('aria-hidden', 'true');
      } else {
        container.removeAttribute('aria-hidden');
      }
      terminalContainer.classList.add('hidden');
    }

    if (maximizeButton) {
      const pressed = isMaximized;
      maximizeButton.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      const label = pressed ? 'Restore terminals' : 'Maximize terminal';
      maximizeButton.title = label;
      maximizeButton.setAttribute('aria-label', label);
      maximizeButton.classList.toggle('active', pressed);
    }
  });

  renderPrimaryAgentSwitcher(activeTab ?? null, activeMaximizedByColumn);
  applyPaneSizing(visibleByColumn);
  updateWorkspaceEmptyState();
}

export function focusFirstTerminal(): void {
  const activeTab = state.tabs[state.activeTabIndex];
  if (!activeTab) {
    return;
  }
  const activeMaximizedByColumn = state.maximizedPaneByTab.get(activeTab.id) ?? {};
  const primaryMaximizedIndexRaw = activeMaximizedByColumn.primary;
  const primaryMaximizedIndex =
    typeof primaryMaximizedIndexRaw === 'number' ? primaryMaximizedIndexRaw : null;
  const primaryFocusMode = shouldUsePrimaryAgentSwitcher(activeTab ?? null, primaryMaximizedIndex);
  const focusedPrimaryPaneIndex = primaryFocusMode ? resolveFocusedPrimaryPaneIndex(activeTab ?? null) : null;
  const firstPane = activeTab.panes.find((pane) => {
    if (pane.status !== 'connected') {
      return false;
    }
    const columnMaximizedIndexRaw = activeMaximizedByColumn[pane.column];
    const columnMaximizedIndex =
      typeof columnMaximizedIndexRaw === 'number' ? columnMaximizedIndexRaw : null;
    if (columnMaximizedIndex !== null && columnMaximizedIndex !== pane.index) {
      return false;
    }
    if (
      primaryFocusMode
      && pane.column === 'primary'
      && focusedPrimaryPaneIndex !== null
      && pane.index !== focusedPrimaryPaneIndex
    ) {
      return false;
    }
    return true;
  });
  if (!firstPane) {
    return;
  }
  const terminal = state.terminals.get(firstPane.index) ?? ensureTerminal(firstPane.index);
  terminal?.focus();
}

export function removePaneAt(
  index: number,
  { tabId, tabIndex }: { tabId?: string; tabIndex?: number } = {},
): boolean {
  const paneState = state.panes.get(index);
  if (!paneState) {
    return false;
  }

  cancelPendingCollapse(paneState);
  resetPaneActivity(index);
  retirePaneActivity(index);
  disposeTerminal(index);
  paneState.elements.container.remove();

  state.panes.delete(index);
  state.terminals.delete(index);
  state.fitAddons.delete(index);
  state.pendingPayloads.delete(index);
  state.scheduledFits.delete(index);
  state.decoders.delete(index);
  state.pendingGitStatuses.delete(index);
  state.unreadPrimaryOutputByPane.delete(index);

  const resolvedTabId = typeof tabId === 'string' && tabId.length > 0 ? tabId : null;
  const providedTabIndex = Number.isFinite(tabIndex) ? Number(tabIndex) : null;
  const fallbackTabIndex = paneState.tabIndex;

  let tab: TabState | undefined;
  if (resolvedTabId) {
    tab = state.tabs.find((candidate) => candidate.id === resolvedTabId);
  }
  if (!tab && providedTabIndex !== null) {
    tab = state.tabs[providedTabIndex];
  }
  if (!tab && fallbackTabIndex >= 0) {
    tab = state.tabs[fallbackTabIndex];
  }
  if (!tab) {
    tab = state.tabs.find((candidate) => candidate.panes.some((pane) => pane.index === index));
  }

  if (tab) {
    removePaneFromLayout(tab.id, index);
    const maximizedRecord = state.maximizedPaneByTab.get(tab.id);
    const paneColumn = paneState.descriptor.column;
    const currentMaximized = maximizedRecord ? maximizedRecord[paneColumn] : undefined;
    if (typeof currentMaximized === 'number' && currentMaximized === index) {
      clearMaximizedPaneIndex(tab.id, paneColumn);
    }
    const removeIndex = tab.panes.findIndex((pane) => pane.index === index);
    if (removeIndex !== -1) {
      tab.panes.splice(removeIndex, 1);
    }
    if (paneState.descriptor.column === 'primary') {
      const remainingPrimaryPaneIndices = getPrimaryPaneDescriptors(tab).map((pane) => pane.index);
      const currentFocusedPrimaryPaneIndex = state.focusedPrimaryPaneByTab.get(tab.id);
      if (currentFocusedPrimaryPaneIndex === index) {
        const fallback = remainingPrimaryPaneIndices[Math.min(removeIndex, remainingPrimaryPaneIndices.length - 1)];
        if (typeof fallback === 'number') {
          setFocusedPrimaryPaneIndex(tab.id, fallback);
        } else {
          clearFocusedPrimaryPaneIndex(tab.id);
        }
      } else if (
        typeof currentFocusedPrimaryPaneIndex === 'number'
        && !remainingPrimaryPaneIndices.includes(currentFocusedPrimaryPaneIndex)
      ) {
        clearFocusedPrimaryPaneIndex(tab.id);
      }
    }
    const updatedTabIndex = state.tabs.findIndex((candidate) => candidate.id === tab.id);
    tab.panes.forEach((pane) => {
      const related = state.panes.get(pane.index);
      if (related) {
        related.tabIndex = updatedTabIndex;
        related.elements.container.dataset['tabIndex'] = String(updatedTabIndex);
      }
    });
  }

  updateVisiblePanes();
  return true;
}
