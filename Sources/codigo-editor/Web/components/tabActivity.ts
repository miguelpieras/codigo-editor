import { aiWorkSummaryElement, aiWorkTotalElement } from './dom.js';
import { state } from './state.js';
import { notifyNative } from './nativeBridge.js';
import type { PaneStatus, TabActivityState, Terminal } from './types.js';

const tabElements = new Map<string, HTMLDivElement>();
const idleTimers = new Map<string, number>();
const lifecycleByTab = new Map<string, TabLifecycle>();
const activeTabs = new Set<string>();
const hintBuffers = new Map<string, string>();
const pendingUserInputEcho = new Map<number, string>();

const paneLifecycles = new Map<number, PaneLifecycle>();
const panesByTab = new Map<string, Set<number>>();
const retiredPaneTotalsByTab = new Map<string, number>();
const paneIndicators = new Map<number, PaneIndicator>();

const TAB_ACTIVITY_IDLE_DELAY_MS = 1800;
const DURATION_UPDATE_INTERVAL_MS = 1000;
const ESC_HINT_REGEX = /esc\s+to\s+interrupt/i;
const ESCAPE_CHARACTER = String.fromCharCode(0x1b);
const BELL_CHARACTER = String.fromCharCode(0x07);

function escapeForRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OSC_SEQUENCE_REGEX = new RegExp(
  `${escapeForRegularExpression(ESCAPE_CHARACTER)}\\][^${escapeForRegularExpression(BELL_CHARACTER)}${escapeForRegularExpression(ESCAPE_CHARACTER)}]*(?:${escapeForRegularExpression(BELL_CHARACTER)}|${escapeForRegularExpression(ESCAPE_CHARACTER)}\\\\)`,
  'g',
);
const DCS_SEQUENCE_REGEX = new RegExp(
  `${escapeForRegularExpression(ESCAPE_CHARACTER)}P[\\s\\S]*?${escapeForRegularExpression(ESCAPE_CHARACTER)}\\\\`,
  'g',
);
const CSI_SEQUENCE_REGEX = new RegExp(
  `${escapeForRegularExpression(ESCAPE_CHARACTER)}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);
const SINGLE_ESCAPE_SEQUENCE_REGEX = new RegExp(
  `${escapeForRegularExpression(ESCAPE_CHARACTER)}[@-_]`,
  'g',
);
const FALLBACK_ESCAPE_SEQUENCE_REGEX = new RegExp(
  `${escapeForRegularExpression(ESCAPE_CHARACTER)}.`,
  'g',
);

let audioContext: AudioContext | null = null;
let durationInterval: number | null = null;
let accumulatedWorkMs = 0;

updateAiWorkDisplay();

type NativeTabActivity = TabActivityState | 'removed' | 'reset';

function sendTabActivityToNative(activity: NativeTabActivity, tabId?: string, overrideTitle?: string): void {
  const payload: {
    activity: NativeTabActivity;
    tabId?: string;
    title?: string;
  } = { activity };
  if (tabId) {
    payload.tabId = tabId;
    const titleSource = overrideTitle ?? state.tabs.find((candidate) => candidate.id === tabId)?.title ?? '';
    const trimmedTitle = titleSource.trim();
    if (trimmedTitle.length > 0) {
      payload.title = trimmedTitle;
    }
  }
  notifyNative('tabActivity', payload);
}

interface TabLifecycle {
  tabId: string;
  lastState: TabActivityState;
  hasSeenActivity: boolean;
  hasInterruptHint: boolean;
  display?: HTMLSpanElement;
  lastActivityAt: number;
  pendingIdleDeadline: number | null;
  displaySeconds: number;
  lastCommittedDisplayMs: number;
}

interface PaneLifecycle {
  tabId: string;
  workStart: number | null;
  cumulativeMs: number;
  lastActivityAt: number;
  pendingIdleTimer: number | null;
  lastCommittedDisplayMs: number;
  lastState: TabActivityState;
}

interface PaneIndicator {
  tabId: string;
  header: HTMLElement;
  badge: HTMLSpanElement;
  statusLabel: HTMLSpanElement;
  durationLabel: HTMLSpanElement;
  lastState: TabActivityState;
  lastDisplaySeconds: number;
}

const PANE_ACTIVITY_LABELS: Record<TabActivityState, string> = {
  loading: 'Starting',
  idle: 'Idle',
  active: 'Working',
};

type AudioContextConstructor = typeof AudioContext;

function audioContextCtor(): AudioContextConstructor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
}

function ensureLifecycle(tabId: string): TabLifecycle {
  let lifecycle = lifecycleByTab.get(tabId);
  if (!lifecycle) {
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    const initialState: TabActivityState = tab?.activity ?? 'loading';
    const initialActive = initialState !== 'loading';
    lifecycle = {
      tabId,
      lastState: initialState,
      hasSeenActivity: initialActive,
      hasInterruptHint: initialActive,
      lastActivityAt: 0,
      pendingIdleDeadline: null,
      displaySeconds: 0,
      lastCommittedDisplayMs: 0,
    };
    lifecycleByTab.set(tabId, lifecycle);
    if (initialActive) {
      hintBuffers.set(tabId, '');
    }
  } else if (lifecycle.tabId !== tabId) {
    lifecycle.tabId = tabId;
  }
  if (typeof lifecycle.lastCommittedDisplayMs !== 'number') {
    lifecycle.lastCommittedDisplayMs = 0;
  }
  return lifecycle;
}

function findTabActivityState(tabId: string): TabActivityState {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  return tab?.activity ?? 'loading';
}

function storeTabActivity(tabId: string, activity: TabActivityState): void {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (tab) {
    tab.activity = activity;
  }
}

function getTabElement(tabId: string): HTMLDivElement | null {
  const element = tabElements.get(tabId);
  if (element) {
    return element;
  }
  const discovered = document.querySelector<HTMLDivElement>(`.tab[data-tab-id="${tabId}"]`);
  if (discovered) {
    tabElements.set(tabId, discovered);
  }
  return discovered ?? null;
}

function computeLifecycleTotalMs(lifecycle: TabLifecycle, referenceTime: number = performance.now()): number {
  return Math.max(0, sumPaneWorkMs(lifecycle.tabId, referenceTime));
}

function commitLifecycleWork(
  lifecycle: TabLifecycle,
  { suppressUpdate = false }: { suppressUpdate?: boolean } = {},
): void {
  const referenceTime = performance.now();
  const totalMs = resetPaneWorkForTab(lifecycle.tabId, referenceTime, { retire: true });
  if (totalMs > 0) {
    accumulatedWorkMs += totalMs;
  }
  lifecycle.lastCommittedDisplayMs = totalMs;
  lifecycle.displaySeconds = Math.max(0, Math.floor(totalMs / 1000));
  if (lifecycle.display) {
    lifecycle.display.textContent = totalMs > 0 ? formatDuration(totalMs) : '';
  }
  if (!suppressUpdate) {
    updateAiWorkDisplay();
  }
}

function stripControlSequences(raw: string): string {
  return raw
    .replace(OSC_SEQUENCE_REGEX, '')
    .replace(DCS_SEQUENCE_REGEX, '')
    .replace(CSI_SEQUENCE_REGEX, '')
    .replace(SINGLE_ESCAPE_SEQUENCE_REGEX, '')
    .replace(FALLBACK_ESCAPE_SEQUENCE_REGEX, '');
}

function registerHintBuffer(tabId: string, cleanChunk: string): boolean {
  if (!cleanChunk) {
    return false;
  }
  const previous = hintBuffers.get(tabId) ?? '';
  const combined = (previous + cleanChunk).slice(-200);
  if (ESC_HINT_REGEX.test(combined)) {
    hintBuffers.set(tabId, '');
    return true;
  }
  hintBuffers.set(tabId, combined);
  return false;
}

function paneShowsInterruptHint(paneIndex: number): boolean {
  const pane = state.panes.get(paneIndex);
  if (!pane || pane.descriptor.column !== 'primary') {
    return false;
  }

  const terminal = state.terminals.get(paneIndex) as (Terminal & {
    buffer?: {
      active?: {
        baseY?: number;
        length: number;
        getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
      };
    };
  }) | undefined;

  const buffer = terminal?.buffer?.active;
  if (!buffer) {
    return false;
  }

  const totalLines = typeof buffer.length === 'number' ? buffer.length : 0;
  if (totalLines === 0) {
    return false;
  }

  const visibleRows = typeof terminal?.rows === 'number' && terminal.rows > 0 ? terminal.rows : 24;
  const baseY = typeof buffer.baseY === 'number'
    ? buffer.baseY
    : Math.max(0, totalLines - visibleRows);

  if (baseY >= totalLines) {
    return false;
  }

  const end = Math.min(totalLines - 1, baseY + visibleRows - 1);
  const start = Math.max(0, end - visibleRows + 1);

  for (let lineIndex = end; lineIndex >= start; lineIndex -= 1) {
    const line = buffer.getLine(lineIndex);
    if (!line) {
      continue;
    }
    const text = line.translateToString(true);
    if (text && ESC_HINT_REGEX.test(text)) {
      return true;
    }
  }

  return false;
}

function tabShowsInterruptHint(tabId: string): boolean {
  const paneSet = panesByTab.get(tabId);
  if (!paneSet) {
    return false;
  }
  for (const paneIndex of paneSet) {
    if (paneShowsInterruptHint(paneIndex)) {
      return true;
    }
  }
  return false;
}

function ensureDisplayElement(element: HTMLDivElement): HTMLSpanElement {
  const existing = element.querySelector<HTMLSpanElement>('.tab-work-duration');
  if (existing) {
    return existing;
  }
  const span = document.createElement('span');
  span.className = 'tab-work-duration';
  const closeButton = element.querySelector('.tab-close-button');
  if (closeButton && closeButton.parentElement === element) {
    element.insertBefore(span, closeButton);
  } else {
    element.appendChild(span);
  }
  return span;
}

function trackPaneForTab(tabId: string, paneIndex: number): void {
  let paneSet = panesByTab.get(tabId);
  if (!paneSet) {
    paneSet = new Set<number>();
    panesByTab.set(tabId, paneSet);
  }
  paneSet.add(paneIndex);
}

function ensurePaneLifecycle(paneIndex: number, tabId: string): PaneLifecycle {
  let lifecycle = paneLifecycles.get(paneIndex);
  if (!lifecycle) {
    lifecycle = {
      tabId,
      workStart: null,
      cumulativeMs: 0,
      lastActivityAt: 0,
      pendingIdleTimer: null,
      lastCommittedDisplayMs: 0,
      lastState: 'loading',
    };
    paneLifecycles.set(paneIndex, lifecycle);
  } else if (lifecycle.tabId !== tabId) {
    lifecycle.tabId = tabId;
  }
  trackPaneForTab(tabId, paneIndex);
  if (typeof lifecycle.lastCommittedDisplayMs !== 'number') {
    lifecycle.lastCommittedDisplayMs = 0;
  }
  if (lifecycle.lastState !== 'loading' && lifecycle.lastState !== 'idle' && lifecycle.lastState !== 'active') {
    lifecycle.lastState = 'loading';
  }
  return lifecycle;
}

function mountPaneIndicator(indicator: PaneIndicator, header: HTMLElement): void {
  const badge = indicator.badge;
  badge.remove();
  const titleGroup = header.querySelector('.pane-title-group');
  if (titleGroup) {
    const titleElement = titleGroup.querySelector('.title');
    if (titleElement && titleElement.parentElement === titleGroup) {
      titleElement.insertAdjacentElement('beforebegin', badge);
      return;
    }
    titleGroup.appendChild(badge);
    return;
  }
  header.insertBefore(badge, header.firstChild);
}

function updatePaneIndicatorAria(indicator: PaneIndicator): void {
  const statusText = PANE_ACTIVITY_LABELS[indicator.lastState];
  const durationText = indicator.durationLabel.textContent?.trim() ?? '';
  const label = durationText.length > 0 ? `${statusText} — ${durationText}` : statusText;
  indicator.badge.setAttribute('aria-label', label);
  indicator.badge.title = label;
}

function ensurePaneIndicatorFor(paneIndex: number, tabId: string, header: HTMLElement): PaneIndicator {
  let indicator = paneIndicators.get(paneIndex);
  if (!indicator) {
    const badge = document.createElement('span');
    badge.className = 'pane-activity-badge';
    badge.dataset['activity'] = 'loading';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');

    const statusLabel = document.createElement('span');
    statusLabel.className = 'pane-activity-status';
    statusLabel.textContent = PANE_ACTIVITY_LABELS.loading;
    badge.appendChild(statusLabel);

    const durationLabel = document.createElement('span');
    durationLabel.className = 'pane-work-duration';
    badge.appendChild(durationLabel);

    indicator = {
      tabId,
      header,
      badge,
      statusLabel,
      durationLabel,
      lastState: 'loading',
      lastDisplaySeconds: 0,
    };
    paneIndicators.set(paneIndex, indicator);
  } else {
    indicator.tabId = tabId;
    indicator.header = header;
  }

  const lifecycle = paneLifecycles.get(paneIndex);
  const currentState = lifecycle?.lastState ?? indicator.lastState;
  indicator.lastState = currentState;
  indicator.badge.dataset['activity'] = currentState;
  indicator.statusLabel.textContent = PANE_ACTIVITY_LABELS[currentState];

  if (lifecycle && typeof lifecycle.lastCommittedDisplayMs === 'number' && lifecycle.lastCommittedDisplayMs > 0) {
    const seconds = Math.max(0, Math.floor(lifecycle.lastCommittedDisplayMs / 1000));
    indicator.lastDisplaySeconds = seconds;
    indicator.durationLabel.textContent = seconds > 0 ? formatDuration(seconds * 1000) : '';
  } else if (indicator.lastDisplaySeconds > 0) {
    indicator.durationLabel.textContent = formatDuration(indicator.lastDisplaySeconds * 1000);
  } else {
    indicator.lastDisplaySeconds = 0;
    indicator.durationLabel.textContent = '';
  }

  mountPaneIndicator(indicator, header);
  header.dataset['activity'] = indicator.lastState;
  updatePaneIndicatorAria(indicator);
  return indicator;
}

function setPaneIndicatorActivity(paneIndex: number, activity: TabActivityState): void {
  const indicator = paneIndicators.get(paneIndex);
  if (!indicator) {
    return;
  }
  if (indicator.lastState === activity) {
    return;
  }
  indicator.lastState = activity;
  indicator.badge.dataset['activity'] = activity;
  indicator.statusLabel.textContent = PANE_ACTIVITY_LABELS[activity];
  indicator.header.dataset['activity'] = activity;
  updatePaneIndicatorAria(indicator);
}

function updatePaneIndicatorDuration(paneIndex: number, ms: number): void {
  const indicator = paneIndicators.get(paneIndex);
  if (!indicator) {
    return;
  }
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (indicator.lastDisplaySeconds === seconds) {
    return;
  }
  indicator.lastDisplaySeconds = seconds;
  indicator.durationLabel.textContent = seconds > 0 ? formatDuration(seconds * 1000) : '';
  updatePaneIndicatorAria(indicator);
}

function updateRegisteredPaneDuration(paneIndex: number, lifecycle: PaneLifecycle, ms: number): void {
  const clamped = Math.max(0, ms);
  lifecycle.lastCommittedDisplayMs = clamped;
  updatePaneIndicatorDuration(paneIndex, clamped);
}

function setPaneActivityState(paneIndex: number, activity: TabActivityState): void {
  const lifecycle = paneLifecycles.get(paneIndex);
  if (lifecycle) {
    lifecycle.lastState = activity;
  }
  setPaneIndicatorActivity(paneIndex, activity);
}

function desiredActivityForStatus(status: PaneStatus, lifecycle: PaneLifecycle): TabActivityState {
  if (status === 'connected') {
    if (lifecycle.workStart !== null || lifecycle.lastState === 'active') {
      return 'active';
    }
    return 'idle';
  }
  return 'loading';
}

function applyStatusToPaneLifecycle(
  paneIndex: number,
  lifecycle: PaneLifecycle,
  status: PaneStatus,
  { resetDuration = false }: { resetDuration?: boolean } = {},
): void {
  const nextState = desiredActivityForStatus(status, lifecycle);
  if (nextState !== 'active') {
    if (resetDuration || status !== 'connected') {
      updateRegisteredPaneDuration(paneIndex, lifecycle, 0);
    }
  }
  setPaneActivityState(paneIndex, nextState);
}

function unregisterPaneIndicator(paneIndex: number): void {
  const indicator = paneIndicators.get(paneIndex);
  if (!indicator) {
    return;
  }
  indicator.badge.remove();
  if (indicator.header.dataset['activity']) {
    delete indicator.header.dataset['activity'];
  }
  paneIndicators.delete(paneIndex);
}

function applyActivityToPaneSet(
  tabId: string,
  activity: TabActivityState,
  { resetDuration = false }: { resetDuration?: boolean } = {},
): void {
  const paneSet = panesByTab.get(tabId);
  if (!paneSet) {
    return;
  }
  paneSet.forEach((paneIndex) => {
    if (resetDuration) {
      const lifecycle = paneLifecycles.get(paneIndex);
      if (lifecycle) {
        updateRegisteredPaneDuration(paneIndex, lifecycle, 0);
      } else {
        updatePaneIndicatorDuration(paneIndex, 0);
      }
    }
    setPaneActivityState(paneIndex, activity);
  });
}

function activatePaneLifecycle(paneIndex: number, tabId: string, referenceTime: number): void {
  const lifecycle = ensurePaneLifecycle(paneIndex, tabId);
  if (lifecycle.workStart === null) {
    lifecycle.workStart = referenceTime;
  }
  lifecycle.lastActivityAt = referenceTime;
  schedulePaneIdle(paneIndex, lifecycle);
}

function clearPaneIdleTimer(lifecycle: PaneLifecycle): void {
  if (lifecycle.pendingIdleTimer !== null) {
    window.clearTimeout(lifecycle.pendingIdleTimer);
    lifecycle.pendingIdleTimer = null;
  }
}

function schedulePaneIdle(paneIndex: number, lifecycle: PaneLifecycle): void {
  clearPaneIdleTimer(lifecycle);
  lifecycle.pendingIdleTimer = window.setTimeout(() => {
    lifecycle.pendingIdleTimer = null;
    handlePaneIdle(paneIndex);
  }, TAB_ACTIVITY_IDLE_DELAY_MS);
}

function activePaneCount(tabId: string): number {
  const paneSet = panesByTab.get(tabId);
  if (!paneSet) {
    return 0;
  }
  let count = 0;
  paneSet.forEach((paneIndex) => {
    const lifecycle = paneLifecycles.get(paneIndex);
    if (lifecycle?.workStart !== null) {
      count += 1;
    }
  });
  return count;
}

function finalizeActivePaneWork(tabId: string, referenceTime: number): void {
  const paneSet = panesByTab.get(tabId);
  if (!paneSet) {
    return;
  }
  paneSet.forEach((paneIndex) => {
    const lifecycle = paneLifecycles.get(paneIndex);
    const workStart = lifecycle?.workStart;
    if (!lifecycle || workStart === null || workStart === undefined) {
      return;
    }
    lifecycle.cumulativeMs += Math.max(0, referenceTime - workStart);
    lifecycle.workStart = null;
    lifecycle.lastActivityAt = referenceTime;
  });
}

function finalizePaneLifecycleNow(paneIndex: number, referenceTime: number = performance.now()): number {
  const lifecycle = paneLifecycles.get(paneIndex);
  if (!lifecycle) {
    return 0;
  }
  clearPaneIdleTimer(lifecycle);
  if (lifecycle.workStart !== null) {
    lifecycle.cumulativeMs += Math.max(0, referenceTime - lifecycle.workStart);
    lifecycle.workStart = null;
  }
  lifecycle.lastActivityAt = referenceTime;
  updateRegisteredPaneDuration(paneIndex, lifecycle, lifecycle.cumulativeMs);
  return lifecycle.cumulativeMs;
}

function handlePaneIdle(paneIndex: number): void {
  const lifecycle = paneLifecycles.get(paneIndex);
  const workStart = lifecycle?.workStart;
  if (!lifecycle || workStart === null || workStart === undefined) {
    return;
  }
  const referenceTime = performance.now();
  lifecycle.cumulativeMs += Math.max(0, referenceTime - workStart);
  lifecycle.workStart = null;
  lifecycle.lastActivityAt = referenceTime;
  updateRegisteredPaneDuration(paneIndex, lifecycle, lifecycle.cumulativeMs);
  setPaneActivityState(paneIndex, 'idle');

  const tabLifecycle = lifecycleByTab.get(lifecycle.tabId);
  if (tabLifecycle) {
    updateDisplay(lifecycle.tabId, tabLifecycle, referenceTime);
    if (activePaneCount(lifecycle.tabId) === 0 && tabLifecycle.lastState === 'active') {
      clearScheduledIdle(lifecycle.tabId);
      updateTabActivity(lifecycle.tabId, 'idle');
    }
  }
}

function sumPaneWorkMs(tabId: string, referenceTime: number): number {
  let total = retiredPaneTotalsByTab.get(tabId) ?? 0;
  const paneSet = panesByTab.get(tabId);
  if (!paneSet) {
    return total;
  }
  paneSet.forEach((paneIndex) => {
    const lifecycle = paneLifecycles.get(paneIndex);
    if (!lifecycle) {
      return;
    }
    total += lifecycle.cumulativeMs;
    if (lifecycle.workStart !== null) {
      total += Math.max(0, referenceTime - lifecycle.workStart);
    }
  });
  return total;
}

function resetPaneWorkForTab(
  tabId: string,
  referenceTime: number,
  { retire = false }: { retire?: boolean } = {},
): number {
  let total = retiredPaneTotalsByTab.get(tabId) ?? 0;
  if (retire) {
    retiredPaneTotalsByTab.delete(tabId);
  }
  const paneSet = panesByTab.get(tabId);
  if (paneSet) {
    paneSet.forEach((paneIndex) => {
      const lifecycle = paneLifecycles.get(paneIndex);
      if (!lifecycle) {
        return;
      }
      clearPaneIdleTimer(lifecycle);
      if (lifecycle.workStart !== null) {
        lifecycle.cumulativeMs += Math.max(0, referenceTime - lifecycle.workStart);
        lifecycle.workStart = null;
      }
      const paneTotal = Math.max(0, lifecycle.cumulativeMs);
      total += paneTotal;
      updateRegisteredPaneDuration(paneIndex, lifecycle, paneTotal);
      lifecycle.cumulativeMs = retire ? 0 : lifecycle.cumulativeMs;
      lifecycle.lastActivityAt = referenceTime;
    });
  }
  return total;
}

function retirePaneLifecycle(paneIndex: number, referenceTime: number = performance.now()): void {
  const lifecycle = paneLifecycles.get(paneIndex);
  if (!lifecycle) {
    return;
  }
  finalizePaneLifecycleNow(paneIndex, referenceTime);
  const tabId = lifecycle.tabId;
  const paneTotal = Math.max(0, lifecycle.lastCommittedDisplayMs ?? lifecycle.cumulativeMs);
  const existing = retiredPaneTotalsByTab.get(tabId) ?? 0;
  retiredPaneTotalsByTab.set(tabId, existing + paneTotal);
  paneLifecycles.delete(paneIndex);
  const paneSet = panesByTab.get(tabId);
  if (paneSet) {
    paneSet.delete(paneIndex);
    if (paneSet.size === 0) {
      panesByTab.delete(tabId);
    }
  }
  unregisterPaneIndicator(paneIndex);
}

function applyActivityToElement(tabId: string, activity: TabActivityState): void {
  const element = getTabElement(tabId);
  if (element) {
    element.dataset['activity'] = activity;
  }
}

function clearScheduledIdle(tabId: string): void {
  const timer = idleTimers.get(tabId);
  if (typeof timer === 'number') {
    window.clearTimeout(timer);
    idleTimers.delete(tabId);
  }
  const lifecycle = lifecycleByTab.get(tabId);
  if (lifecycle) {
    lifecycle.pendingIdleDeadline = null;
  }
}

function scheduleIdle(tabId: string): void {
  const lifecycle = lifecycleByTab.get(tabId);
  if (!lifecycle) {
    return;
  }
  clearScheduledIdle(tabId);
  const deadline = performance.now() + TAB_ACTIVITY_IDLE_DELAY_MS;
  lifecycle.pendingIdleDeadline = deadline;
  const timer = window.setTimeout(() => {
    idleTimers.delete(tabId);
    const current = lifecycleByTab.get(tabId);
    if (!current || current.pendingIdleDeadline !== deadline) {
      return;
    }
    if (current.lastState !== 'active') {
      return;
    }
    if (tabShowsInterruptHint(tabId)) {
      current.lastActivityAt = performance.now();
      scheduleIdle(tabId);
      return;
    }
    const elapsed = performance.now() - current.lastActivityAt;
    if (elapsed < TAB_ACTIVITY_IDLE_DELAY_MS - 50) {
      scheduleIdle(tabId);
      return;
    }
    updateTabActivity(tabId, 'idle');
  }, TAB_ACTIVITY_IDLE_DELAY_MS);
  idleTimers.set(tabId, timer);
}

function ensureDurationInterval(): void {
  if (durationInterval !== null || activeTabs.size === 0) {
    return;
  }
  durationInterval = window.setInterval(() => {
    const now = performance.now();
    activeTabs.forEach((tabId) => {
      const lifecycle = lifecycleByTab.get(tabId);
      if (!lifecycle || activePaneCount(tabId) === 0) {
        activeTabs.delete(tabId);
        return;
      }
      const paneSet = panesByTab.get(tabId);
      if (paneSet) {
        paneSet.forEach((paneIndex) => {
          const paneLifecycle = paneLifecycles.get(paneIndex);
          const workStart = paneLifecycle?.workStart;
          if (!paneLifecycle || workStart === null || workStart === undefined) {
            return;
          }
          const elapsed = Math.max(0, now - workStart);
          const paneTotal = Math.max(0, paneLifecycle.cumulativeMs + elapsed);
          updateRegisteredPaneDuration(paneIndex, paneLifecycle, paneTotal);
        });
      }
      updateDisplay(tabId, lifecycle, now, false);
    });
    if (activeTabs.size === 0) {
      clearDurationIntervalIfNeeded();
    }
    updateAiWorkDisplay();
  }, DURATION_UPDATE_INTERVAL_MS);
}

function clearDurationIntervalIfNeeded(): void {
  if (activeTabs.size === 0 && durationInterval !== null) {
    window.clearInterval(durationInterval);
    durationInterval = null;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function updateAiWorkDisplay(): void {
  let totalMs = accumulatedWorkMs;
  const referenceTime = performance.now();
  lifecycleByTab.forEach((lifecycle) => {
    totalMs += computeLifecycleTotalMs(lifecycle, referenceTime);
  });
  const formatted = formatDuration(totalMs);
  aiWorkTotalElement.textContent = formatted;
  aiWorkSummaryElement.title = `Total AI work time: ${formatted}`;
  aiWorkSummaryElement.setAttribute('aria-label', `Total AI work time ${formatted}`);
}

const MAX_PENDING_USER_INPUT = 1_600;

function sanitiseForEchoComparison(text: string): string {
  if (!text) {
    return '';
  }
  return stripControlSequences(text).replace(/\r/g, '').split(BELL_CHARACTER).join('');
}

function consumePendingUserInputEcho(paneIndex: number, payload: string): string {
  const sanitisedPayload = sanitiseForEchoComparison(payload);
  if (!sanitisedPayload) {
    return '';
  }

  const pending = pendingUserInputEcho.get(paneIndex);
  if (!pending || pending.length === 0) {
    return sanitisedPayload;
  }

  if (sanitisedPayload.startsWith(pending)) {
    pendingUserInputEcho.delete(paneIndex);
    return sanitisedPayload.slice(pending.length);
  }

  const exactIndex = sanitisedPayload.indexOf(pending);
  if (exactIndex > 0) {
    pendingUserInputEcho.delete(paneIndex);
    return sanitisedPayload.slice(exactIndex + pending.length);
  }

  let pendingOffset = 0;
  let payloadOffset = 0;
  const pendingLength = pending.length;
  const payloadLength = sanitisedPayload.length;

  while (payloadOffset < payloadLength && sanitisedPayload.charAt(payloadOffset) === '\n' && pendingOffset < pendingLength && pending.charAt(pendingOffset) !== '\n') {
    payloadOffset += 1;
  }

  while (pendingOffset < pendingLength && payloadOffset < payloadLength) {
    const pendingChar = pending.charAt(pendingOffset);
    const payloadChar = sanitisedPayload.charAt(payloadOffset);
    if (pendingChar === payloadChar) {
      pendingOffset += 1;
      payloadOffset += 1;
      continue;
    }
    if (payloadChar === '\n' && pendingChar === '\n') {
      pendingOffset += 1;
      payloadOffset += 1;
      continue;
    }
    break;
  }

  if (pendingOffset >= pendingLength) {
    pendingUserInputEcho.delete(paneIndex);
  } else {
    pendingUserInputEcho.set(paneIndex, pending.slice(pendingOffset));
  }

  if (payloadOffset >= payloadLength) {
    return '';
  }

  return sanitisedPayload.slice(payloadOffset);
}

export function noteUserInput(paneIndex: number, data: string): void {
  if (!Number.isFinite(paneIndex) || typeof data !== 'string' || data.length === 0) {
    return;
  }
  const sanitised = sanitiseForEchoComparison(data);
  if (!sanitised) {
    return;
  }
  const existing = pendingUserInputEcho.get(paneIndex) ?? '';
  const updated = (existing + sanitised).slice(-MAX_PENDING_USER_INPUT);
  pendingUserInputEcho.set(paneIndex, updated);
}

export function clearPendingUserInput(paneIndex: number): void {
  pendingUserInputEcho.delete(paneIndex);
}

function clearPendingPromptSubmission(paneIndex: number): void {
  state.promptArmedPrimaryPanes.delete(paneIndex);
}

export function notePanePromptSubmitted(paneIndex: number): void {
  if (!Number.isFinite(paneIndex)) {
    return;
  }
  const pane = state.panes.get(paneIndex);
  if (!pane || pane.descriptor.column !== 'primary' || pane.descriptor.kind !== 'codex') {
    return;
  }
  state.promptArmedPrimaryPanes.add(paneIndex);
}

function updateDisplay(
  tabId: string,
  lifecycle: TabLifecycle,
  referenceTime: number = performance.now(),
  notifySummary = true,
): void {
  const element = getTabElement(tabId);
  if (!element) {
    return;
  }
  const display = lifecycle.display ?? ensureDisplayElement(element);
  lifecycle.display = display;

  const activeMs = computeLifecycleTotalMs(lifecycle, referenceTime);
  const effectiveMs = activeMs > 0 ? activeMs : lifecycle.lastCommittedDisplayMs;
  lifecycle.displaySeconds = Math.max(0, Math.floor(effectiveMs / 1000));
  display.textContent = effectiveMs > 0 ? formatDuration(effectiveMs) : '';
  if (notifySummary) {
    updateAiWorkDisplay();
  }
}

function playIdleChimeIfNeeded(previous: TabActivityState, next: TabActivityState): void {
  if (previous !== 'active' || next !== 'idle') {
    return;
  }
  if (!state.settings.playIdleChime) {
    return;
  }
  const Ctor = audioContextCtor();
  if (!Ctor) {
    return;
  }
  try {
    if (!audioContext) {
      audioContext = new Ctor();
    }
    const ctx = audioContext;
    if (!ctx) {
      return;
    }
    void ctx.resume();
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    oscillator.start(now);
    oscillator.stop(now + 0.45);
  } catch {
    // Ignore playback errors; browsers may block audio without a gesture.
  }
}

function updateTabActivity(tabId: string, activity: TabActivityState): boolean {
  const lifecycle = ensureLifecycle(tabId);

  if (activity === 'active' && !lifecycle.hasInterruptHint) {
    return false;
  }

  const previous = lifecycle.lastState;
  if (activity === previous) {
    if (activity === 'loading') {
      applyActivityToElement(tabId, activity);
      updateDisplay(tabId, lifecycle);
    }
    return false;
  }

  const referenceTime = performance.now();
  storeTabActivity(tabId, activity);

  if (activity === 'active') {
    lifecycle.lastCommittedDisplayMs = 0;
    lifecycle.hasSeenActivity = true;
    lifecycle.lastActivityAt = referenceTime;
    activeTabs.add(tabId);
    ensureDurationInterval();
  } else {
    finalizeActivePaneWork(tabId, referenceTime);
    activeTabs.delete(tabId);
    clearDurationIntervalIfNeeded();
    if (activity === 'loading') {
      commitLifecycleWork(lifecycle);
      lifecycle.hasSeenActivity = false;
      lifecycle.hasInterruptHint = false;
      hintBuffers.delete(tabId);
      applyActivityToPaneSet(tabId, 'loading', { resetDuration: true });
    }
    if (activity === 'idle') {
      lifecycle.hasInterruptHint = false;
      hintBuffers.delete(tabId);
      commitLifecycleWork(lifecycle);
      applyActivityToPaneSet(tabId, 'idle');
    }
    lifecycle.pendingIdleDeadline = null;
  }

  applyActivityToElement(tabId, activity);
  playIdleChimeIfNeeded(previous, activity);
  lifecycle.lastState = activity;
  updateDisplay(tabId, lifecycle, referenceTime);
  sendTabActivityToNative(activity, tabId);
  return true;
}

export function resetTabElementRegistry(): void {
  tabElements.clear();
}

export function registerTabElement(tabId: string, element: HTMLDivElement): void {
  tabElements.set(tabId, element);
  element.dataset['tabId'] = tabId;
  const lifecycle = ensureLifecycle(tabId);
  lifecycle.display = ensureDisplayElement(element);
  const initialState = findTabActivityState(tabId);
  element.dataset['activity'] = initialState;
  lifecycle.lastState = initialState;
  lifecycle.hasSeenActivity = initialState !== 'loading';
  updateDisplay(tabId, lifecycle);
}

export function registerPaneActivityIndicator(
  paneIndex: number,
  tabId: string | null,
  header: HTMLElement | null,
  status: PaneStatus | null,
): void {
  if (!Number.isFinite(paneIndex) || !header || !tabId) {
    return;
  }
  if (tabId.length === 0) {
    return;
  }
  const lifecycle = ensurePaneLifecycle(paneIndex, tabId);
  if (status) {
    applyStatusToPaneLifecycle(paneIndex, lifecycle, status, { resetDuration: true });
  }
  ensurePaneIndicatorFor(paneIndex, tabId, header);
}

export function unregisterPaneActivityIndicator(paneIndex: number): void {
  if (!Number.isFinite(paneIndex)) {
    return;
  }
  unregisterPaneIndicator(paneIndex);
}

export function syncPaneActivityIndicatorWithStatus(
  paneIndex: number,
  tabId: string | null,
  status: PaneStatus | null,
): void {
  if (!Number.isFinite(paneIndex) || !tabId || !status) {
    return;
  }
  if (tabId.length === 0) {
    return;
  }
  const lifecycle = ensurePaneLifecycle(paneIndex, tabId);
  applyStatusToPaneLifecycle(paneIndex, lifecycle, status);
  const indicator = paneIndicators.get(paneIndex);
  if (indicator) {
    updatePaneIndicatorAria(indicator);
  }
}

export function notePaneActivity(paneIndex: number, payloadText?: string): void {
  const pane = state.panes.get(paneIndex);
  if (!pane || pane.descriptor.column !== 'primary') {
    return;
  }

  const tab = state.tabs[pane.tabIndex];
  if (!tab) {
    return;
  }

  const tabId = tab.id;
  const tabLifecycle = ensureLifecycle(tabId);
  const paneLifecycle = ensurePaneLifecycle(paneIndex, tabId);
  const rawPayload = typeof payloadText === 'string' ? payloadText : '';
  const residualPayload = consumePendingUserInputEcho(paneIndex, rawPayload);
  if (residualPayload.length === 0) {
    return;
  }

  const stripped = stripControlSequences(residualPayload);
  const hintCandidate = stripped.trim();
  if (!tabLifecycle.hasInterruptHint) {
    const detected = hintCandidate ? registerHintBuffer(tabId, hintCandidate) : false;
    if (detected) {
      tabLifecycle.hasInterruptHint = true;
    }
  }

  if (!tabLifecycle.hasInterruptHint) {
    return;
  }

  if (!hintCandidate) {
    return;
  }

  if (
    pane.descriptor.kind === 'codex'
    && paneLifecycle.workStart === null
    && !state.promptArmedPrimaryPanes.has(paneIndex)
  ) {
    return;
  }

  const referenceTime = performance.now();
  updateTabActivity(tabId, 'active');
  activatePaneLifecycle(paneIndex, tabId, referenceTime);
  const paneTotal = paneLifecycle.cumulativeMs + (paneLifecycle.workStart !== null ? Math.max(0, referenceTime - paneLifecycle.workStart) : 0);
  updateRegisteredPaneDuration(paneIndex, paneLifecycle, paneTotal);
  setPaneActivityState(paneIndex, 'active');
  const tabState = state.tabs[pane.tabIndex];
  if (tabState?.activity === 'active') {
    tabLifecycle.lastActivityAt = referenceTime;
    scheduleIdle(tabId);
  }
}

export function resetPaneActivity(paneIndex: number): void {
  const pane = state.panes.get(paneIndex);
  const paneLifecycle = paneLifecycles.get(paneIndex);
  const tab = pane ? state.tabs[pane.tabIndex] : null;
  const tabId = paneLifecycle?.tabId ?? tab?.id ?? null;
  if (!tabId) {
    clearPendingUserInput(paneIndex);
    clearPendingPromptSubmission(paneIndex);
    return;
  }

  if (pane && pane.descriptor.column !== 'primary') {
    clearPendingUserInput(paneIndex);
    clearPendingPromptSubmission(paneIndex);
    return;
  }

  finalizePaneLifecycleNow(paneIndex);
  clearPendingUserInput(paneIndex);
  clearPendingPromptSubmission(paneIndex);

  if (paneLifecycle) {
    const nextActivity: TabActivityState = pane?.status === 'connected' ? 'idle' : 'loading';
    if (nextActivity === 'loading') {
      updateRegisteredPaneDuration(paneIndex, paneLifecycle, 0);
    }
    setPaneActivityState(paneIndex, nextActivity);
  }

  if (activePaneCount(tabId) === 0) {
    clearScheduledIdle(tabId);
    updateTabActivity(tabId, 'idle');
  } else {
    const lifecycle = lifecycleByTab.get(tabId);
    if (lifecycle) {
      updateDisplay(tabId, lifecycle);
    }
  }
}

export function retirePaneActivity(paneIndex: number): void {
  const lifecycle = paneLifecycles.get(paneIndex);
  if (!lifecycle) {
    return;
  }
  const tabId = lifecycle.tabId;
  clearPendingPromptSubmission(paneIndex);
  retirePaneLifecycle(paneIndex);
  const tabLifecycle = lifecycleByTab.get(tabId);
  if (tabLifecycle) {
    updateDisplay(tabId, tabLifecycle);
    if (activePaneCount(tabId) === 0 && tabLifecycle.lastState === 'active') {
      clearScheduledIdle(tabId);
      updateTabActivity(tabId, 'idle');
    }
  }
}

export function handleTabRemoved(tabId: string, tabTitle?: string): void {
  clearScheduledIdle(tabId);
  const lifecycle = lifecycleByTab.get(tabId);
  if (lifecycle) {
    commitLifecycleWork(lifecycle, { suppressUpdate: true });
  }
  tabElements.delete(tabId);
  lifecycleByTab.delete(tabId);
  activeTabs.delete(tabId);
  hintBuffers.delete(tabId);
  clearDurationIntervalIfNeeded();
  updateAiWorkDisplay();
  sendTabActivityToNative('removed', tabId, tabTitle);
}

export function handleAllTabsCleared(): void {
  idleTimers.forEach((timer) => window.clearTimeout(timer));
  idleTimers.clear();
  lifecycleByTab.forEach((lifecycle) => {
    commitLifecycleWork(lifecycle, { suppressUpdate: true });
  });
  tabElements.clear();
  lifecycleByTab.clear();
  activeTabs.clear();
  hintBuffers.clear();
  pendingUserInputEcho.clear();
  state.promptArmedPrimaryPanes.clear();
  paneLifecycles.clear();
  panesByTab.clear();
  retiredPaneTotalsByTab.clear();
  paneIndicators.forEach((indicator) => {
    indicator.badge.remove();
    if (indicator.header.dataset['activity']) {
      delete indicator.header.dataset['activity'];
    }
  });
  paneIndicators.clear();
  clearDurationIntervalIfNeeded();
  updateAiWorkDisplay();
  sendTabActivityToNative('reset');
}
