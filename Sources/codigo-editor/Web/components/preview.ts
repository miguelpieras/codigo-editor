import { state } from './state.js';
import { notifyNative } from './nativeBridge.js';
import {
  previewGoButton,
  previewBackButton,
  previewSnapshotButton,
  previewHost,
  previewInput,
  previewOpenExternalButton,
  previewRefreshButton,
  previewTabStrip,
  previewAddTabButton,
  previewColumnHeader,
} from './dom.js';
import type { TabState, PreviewTabState } from './types.js';
import { normaliseStoredPreviewURL } from './dataTransforms.js';
import { createIcon } from './icons.js';
import {
  SnapshotFeedbackController,
  SnapshotFeedbackState,
  normaliseSnapshotResult,
} from './previewSnapshotFeedback.js';
import { generateUUID } from './uuid.js';

const PREVIEW_TITLE_PREFIX = 'Preview';
let previewHostObserver: ResizeObserver | null = null;
let lastPreviewVisible = false;
const lastPreviewRefreshByPane = new Map<number, number>();
const SNAPSHOT_SUCCESS_MESSAGE = 'Copied screenshot to clipboard';
const SNAPSHOT_FAILURE_MESSAGE = 'Copy failed';
const SNAPSHOT_RESET_DELAY = 2000;
const previewSnapshotDefaultTitle = previewSnapshotButton.title || 'Copy screenshot';
const previewSnapshotDefaultLabel = previewSnapshotButton.getAttribute('aria-label') ?? previewSnapshotDefaultTitle;
let snapshotFeedbackStateListener: ((state: SnapshotFeedbackState, message: string) => void) | null = null;
const snapshotFeedback = new SnapshotFeedbackController({
  button: previewSnapshotButton,
  defaultTitle: previewSnapshotDefaultTitle,
  defaultLabel: previewSnapshotDefaultLabel,
  resetDelay: SNAPSHOT_RESET_DELAY,
  onStateChange: (state, message) => {
    snapshotFeedbackStateListener?.(state, message);
  },
});

function sendPreviewLayout(): void {
  if (!previewHost) {
    return;
  }
  const rect = previewHost.getBoundingClientRect();
  notifyNative('previewLayout', {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
}

function ensurePreviewHostObserver(): void {
  if (!previewHost || typeof ResizeObserver !== 'function') {
    return;
  }
  if (previewHostObserver) {
    return;
  }
  previewHostObserver = new ResizeObserver(() => {
    sendPreviewLayout();
  });
  previewHostObserver.observe(previewHost);
}

function setNativePreviewVisibility(visible: boolean): void {
  if (lastPreviewVisible !== visible) {
    lastPreviewVisible = visible;
    notifyNative('previewVisibility', { visible });
  }
  updatePreviewNavigationControls();
}

function updatePreviewNavigationControls(): void {
  if (previewBackButton) {
    previewBackButton.disabled = !state.preview.navigation.canGoBack;
  }
  if (previewSnapshotButton) {
    const activeTab = state.tabs[state.activeTabIndex];
    const activePreviewId = activeTab?.activePreviewTabId ?? null;
    const activePreview = activePreviewId ? activeTab?.previewTabs.find((candidate) => candidate.id === activePreviewId) ?? null : null;
    const hasFrame = activePreview ? state.preview.frames.has(activePreview.id) : false;
    const canCapture = Boolean(activeTab && activePreview && hasFrame && state.columnLayout.visibility.preview);
    previewSnapshotButton.disabled = !canCapture;
  }
}

function resetPreviewNavigationState(): void {
  state.preview.navigation.canGoBack = false;
  state.preview.navigation.canGoForward = false;
  updatePreviewNavigationControls();
}

function notifyNativePreviewNavigation(tab: TabState, previewTab: PreviewTabState, url: string): void {
  notifyNative('previewNavigate', {
    tabId: tab.id,
    previewTabId: previewTab.id,
    url,
  });
}

function goBackPreview(): void {
  const tab = getActiveMainTab();
  if (!tab) {
    return;
  }
  const previewTab = getActivePreviewTab(tab);
  if (!previewTab) {
    return;
  }
  resetPreviewNavigationState();
  notifyNative('previewGoBack', {
    tabId: tab.id,
    previewTabId: previewTab.id,
  });
}

function copyPreviewSnapshot(): void {
  const tab = getActiveMainTab();
  if (!tab) {
    return;
  }
  const previewTab = getActivePreviewTab(tab);
  if (!previewTab) {
    return;
  }
  const frameExists = state.preview.frames.has(previewTab.id);
  if (!frameExists) {
    return;
  }
  if (!state.columnLayout.visibility.preview) {
    return;
  }
  notifyNative('previewSnapshot', {
    tabId: tab.id,
    previewTabId: previewTab.id,
  });
}

function normalisePreviewUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const protocolRelative = trimmed.startsWith('//');
  if (protocolRelative) {
    return `https:${trimmed}`;
  }

  const lowercased = trimmed.toLowerCase();
  const isLocalhost = lowercased.startsWith('localhost') || lowercased.startsWith('127.0.0.1') || lowercased.startsWith('0.0.0.0');
  const hasPort = /:[0-9]+(\/|$)/.test(trimmed);
  const isLocalDomain = lowercased.endsWith('.local');
  const isIPAddress = /^\d{1,3}(\.\d{1,3}){3}(:[0-9]+)?(\/|$)/.test(lowercased);

  const useHttp = isLocalhost || hasPort || isLocalDomain || isIPAddress;
  const scheme = useHttp ? 'http' : 'https';
  return `${scheme}://${trimmed}`;
}

function generatePreviewTabId(existing: Set<string>): string {
  let candidate = generateUUID();
  while (existing.has(candidate)) {
    candidate = generateUUID();
  }
  existing.add(candidate);
  return candidate;
}

function getActiveMainTab(): TabState | undefined {
  return state.tabs[state.activeTabIndex];
}

function extractHost(value: string): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function getPreviewTabById(tab: TabState | undefined, previewTabId: string | null): PreviewTabState | null {
  if (!tab || !previewTabId) {
    return null;
  }
  return tab.previewTabs.find((preview) => preview.id === previewTabId) ?? null;
}

function getActivePreviewTab(tab: TabState | undefined): PreviewTabState | null {
  if (!tab) {
    return null;
  }
  const preview = getPreviewTabById(tab, tab.activePreviewTabId);
  if (preview) {
    return preview;
  }
  const fallback = tab.previewTabs[0] ?? null;
  if (fallback) {
    tab.activePreviewTabId = fallback.id;
    state.preview.activePreviewTabId = fallback.id;
  }
  return fallback;
}

function getStoredPreviewUrl(previewTab: PreviewTabState): string {
  const stored = state.preview.urls.get(previewTab.id);
  return normaliseStoredPreviewURL(stored ?? previewTab.url);
}

function setStoredPreviewUrl(previewTab: PreviewTabState, url: string): void {
  const trimmed = normaliseStoredPreviewURL(url);
  previewTab.url = trimmed;
  state.preview.urls.set(previewTab.id, trimmed);
}

function updateFrameTitle(frame: HTMLIFrameElement, tab: TabState, previewTab: PreviewTabState): void {
  frame.title = `Preview — ${tab.title} — ${previewTab.title}`;
}

function applyPreviewURL(frame: HTMLIFrameElement | null, url: string): void {
  if (!frame) {
    return;
  }
  const next = typeof url === 'string' ? url : '';
  frame.dataset['url'] = next;
  if (frame.src !== 'about:blank') {
    frame.src = 'about:blank';
  }
}

function ensurePreviewFrame(tab: TabState, previewTab: PreviewTabState): HTMLIFrameElement | null {
  if (!previewHost) {
    return null;
  }
  let frame = state.preview.frames.get(previewTab.id) ?? null;
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.pointerEvents = 'none';
    frame.dataset['tabId'] = tab.id;
    frame.dataset['previewTabId'] = previewTab.id;
    updateFrameTitle(frame, tab, previewTab);
    previewHost.appendChild(frame);
    state.preview.frames.set(previewTab.id, frame);
  } else {
    updateFrameTitle(frame, tab, previewTab);
  }
  const storedUrl = getStoredPreviewUrl(previewTab);
  applyPreviewURL(frame, storedUrl);
  updatePreviewNavigationControls();
  return frame;
}

function deriveTitleFromUrl(url: string): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname) {
      return parsed.hostname.replace(/^www\./i, '');
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}

function maybeUpdatePreviewTabTitle(tab: TabState, previewTab: PreviewTabState, url: string): void {
  const defaultTitle = `${PREVIEW_TITLE_PREFIX} ${tab.previewTabs.indexOf(previewTab) + 1}`;
  const hasCustomTitle = previewTab.title && previewTab.title !== defaultTitle;
  if (hasCustomTitle) {
    return;
  }
  const derived = deriveTitleFromUrl(url);
  previewTab.title = derived ?? defaultTitle;
}

function notifyNativePreviewUpdate(tab: TabState): void {
  const tabIndex = state.tabs.indexOf(tab);
  if (tabIndex === -1) {
    return;
  }
  const activePreview = getPreviewTabById(tab, tab.activePreviewTabId);
  notifyNative('updateTabPreview', {
    id: tab.id,
    index: tabIndex,
    activePreviewTabId: tab.activePreviewTabId,
    previewTabs: tab.previewTabs.map((previewTab) => ({
      id: previewTab.id,
      title: previewTab.title,
      url: getStoredPreviewUrl(previewTab),
    })),
    url: activePreview ? getStoredPreviewUrl(activePreview) : null,
  });
}

function setActivePreviewTab(previewTabId: string): void {
  const tab = getActiveMainTab();
  if (!tab || tab.activePreviewTabId === previewTabId) {
    return;
  }
  const previewTab = getPreviewTabById(tab, previewTabId);
  if (!previewTab) {
    return;
  }
  tab.activePreviewTabId = previewTabId;
  state.preview.activePreviewTabId = previewTabId;
  renderPreviewTabs();
  updateActivePreview();
  notifyNativePreviewUpdate(tab);
}

function closePreviewTab(previewTabId: string, tab: TabState | undefined = getActiveMainTab()): void {
  if (!tab) {
    return;
  }
  const index = tab.previewTabs.findIndex((preview) => preview.id === previewTabId);
  if (index === -1) {
    return;
  }
  if (tab.previewTabs.length === 1) {
    const soleTab = tab.previewTabs[0];
    if (soleTab) {
      setStoredPreviewUrl(soleTab, '');
      renderPreviewTabs();
      updateActivePreview();
      notifyNativePreviewUpdate(tab);
    }
    return;
  }
  tab.previewTabs.splice(index, 1);
  state.preview.urls.delete(previewTabId);
  const frame = state.preview.frames.get(previewTabId);
  if (frame) {
    frame.remove();
    state.preview.frames.delete(previewTabId);
  }
  updatePreviewNavigationControls();
  if (tab.activePreviewTabId === previewTabId) {
    const fallback = tab.previewTabs[Math.max(0, index - 1)] ?? tab.previewTabs[0] ?? null;
    tab.activePreviewTabId = fallback?.id ?? null;
    state.preview.activePreviewTabId = tab.activePreviewTabId;
  }
  renderPreviewTabs();
  updateActivePreview();
  notifyNativePreviewUpdate(tab);
}

function createPreviewTabForTab(tab: TabState): PreviewTabState {
  const existingIds = new Set(tab.previewTabs.map((preview) => preview.id));
  const id = generatePreviewTabId(existingIds);
  const title = `${PREVIEW_TITLE_PREFIX} ${tab.previewTabs.length + 1}`;
  const previewTab: PreviewTabState = { id, title, url: '' };
  tab.previewTabs.push(previewTab);
  setStoredPreviewUrl(previewTab, '');
  return previewTab;
}

function addPreviewTab(): void {
  const tab = getActiveMainTab();
  if (!tab) {
    return;
  }
  const existingIds = new Set(tab.previewTabs.map((preview) => preview.id));
  const id = generatePreviewTabId(existingIds);
  const title = `${PREVIEW_TITLE_PREFIX} ${tab.previewTabs.length + 1}`;
  const previewTab: PreviewTabState = { id, title, url: '' };
  tab.previewTabs.push(previewTab);
  setStoredPreviewUrl(previewTab, '');
  tab.activePreviewTabId = id;
  state.preview.activePreviewTabId = id;
  renderPreviewTabs();
  updateActivePreview();
  notifyNativePreviewUpdate(tab);
  previewInput?.focus();
}

function renderPreviewTabs(): void {
  if (!previewTabStrip) {
    return;
  }
  const tab = getActiveMainTab();
  const previewTabs = tab?.previewTabs ?? [];
  previewTabStrip.innerHTML = '';
  if (previewColumnHeader) {
    previewColumnHeader.classList.toggle('empty', previewTabs.length === 0);
  }
  if (!tab || previewTabs.length === 0) {
    if (previewAddTabButton) {
      previewAddTabButton.disabled = true;
    }
    return;
  }
  previewTabs.forEach((previewTab) => {
    const isActive = tab.activePreviewTabId === previewTab.id;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preview-tab column-header-button';
    if (isActive) {
      button.classList.add('active');
    }
    button.dataset['previewTabId'] = previewTab.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    const titleSpan = document.createElement('span');
    titleSpan.className = 'title';
    titleSpan.textContent = previewTab.title;
    button.appendChild(titleSpan);
    if (previewTab.url) {
      button.title = previewTab.url;
    }
    if (previewTabs.length > 1) {
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'preview-tab-close';
      closeButton.setAttribute('aria-label', `Close ${previewTab.title}`);
      closeButton.textContent = '×';
      closeButton.addEventListener('click', (event) => {
        event.stopPropagation();
        closePreviewTab(previewTab.id, tab);
      });
      button.appendChild(closeButton);
    }
    button.addEventListener('click', () => setActivePreviewTab(previewTab.id));
    previewTabStrip.appendChild(button);
  });
  if (previewAddTabButton) {
    previewAddTabButton.disabled = false;
  }
}

export function updateActivePreview(): void {
  renderPreviewTabs();
  if (!previewHost) {
    return;
  }
  const tab = getActiveMainTab();
  if (!tab) {
    state.preview.activePreviewTabId = null;
    state.preview.frames.forEach((frame) => frame.classList.remove('active'));
    if (previewInput) {
      previewInput.value = '';
    }
    resetPreviewNavigationState();
    setNativePreviewVisibility(false);
    return;
  }
  const previewTab = getActivePreviewTab(tab);
  if (!previewTab) {
    state.preview.activePreviewTabId = null;
    state.preview.frames.forEach((frame) => frame.classList.remove('active'));
    if (previewInput) {
      previewInput.value = '';
    }
    resetPreviewNavigationState();
    setNativePreviewVisibility(false);
    return;
  }
  const frame = ensurePreviewFrame(tab, previewTab);
  if (!frame) {
    return;
  }
  state.preview.activePreviewTabId = previewTab.id;
  state.preview.frames.forEach((candidate, id) => {
    candidate.classList.toggle('active', id === previewTab.id);
  });
  resetPreviewNavigationState();
  const storedUrl = getStoredPreviewUrl(previewTab);
  if (previewInput) {
    previewInput.value = storedUrl;
  }
  const hasUrl = storedUrl.length > 0;
  const shouldDisplayPreview = hasUrl && state.columnLayout.visibility.preview;
  setNativePreviewVisibility(shouldDisplayPreview);
  if (state.columnLayout.visibility.preview) {
    if (hasUrl) {
      sendPreviewLayout();
    }
    notifyNativePreviewNavigation(tab, previewTab, storedUrl);
  }
}

interface NativePreviewNavigationPayload {
  tabId?: unknown;
  previewTabId?: unknown;
  url?: unknown;
  canGoBack?: unknown;
  canGoForward?: unknown;
}

export function applyNativePreviewNavigation(raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    return;
  }
  const payload = raw as NativePreviewNavigationPayload;
  const tabId = typeof payload.tabId === 'string' ? payload.tabId : null;
  const previewTabId = typeof payload.previewTabId === 'string' ? payload.previewTabId : null;
  if (!tabId || !previewTabId) {
    return;
  }
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }
  const previewTab = tab.previewTabs.find((candidate) => candidate.id === previewTabId);
  if (!previewTab) {
    return;
  }
  const rawUrl = typeof payload.url === 'string' ? payload.url : '';
  const normalisedUrl = normaliseStoredPreviewURL(rawUrl);
  setStoredPreviewUrl(previewTab, normalisedUrl);
  maybeUpdatePreviewTabTitle(tab, previewTab, normalisedUrl);
  const frame = state.preview.frames.get(previewTab.id);
  if (frame) {
    applyPreviewURL(frame, normalisedUrl);
  }

  const activeTab = getActiveMainTab();
  const isActiveTab = activeTab?.id === tab.id;
  const isActivePreview = tab.activePreviewTabId === previewTab.id;

  if (isActiveTab) {
    if (isActivePreview) {
      state.preview.activePreviewTabId = previewTab.id;
      if (previewInput) {
        previewInput.value = normalisedUrl;
      }
      renderPreviewTabs();
      state.preview.navigation.canGoBack = Boolean(payload.canGoBack);
      state.preview.navigation.canGoForward = Boolean(payload.canGoForward);
      updatePreviewNavigationControls();
    } else {
      renderPreviewTabs();
    }
  }
}

export function navigatePreview(raw: unknown): void {
  const tab = getActiveMainTab();
  if (!tab || !previewHost) {
    return;
  }
  const previewTab = getActivePreviewTab(tab);
  if (!previewTab) {
    return;
  }
  const resolved = normalisePreviewUrl(raw);
  const nextValue = resolved ?? '';
  setStoredPreviewUrl(previewTab, nextValue);
  maybeUpdatePreviewTabTitle(tab, previewTab, nextValue);
  const frame = ensurePreviewFrame(tab, previewTab);
  applyPreviewURL(frame, nextValue);
  renderPreviewTabs();
  if (previewInput) {
    previewInput.value = nextValue;
  }
  notifyNativePreviewUpdate(tab);
  const isActivePreview = tab.activePreviewTabId === previewTab.id;
  const hasUrl = nextValue.length > 0;
  if (isActivePreview && state.columnLayout.visibility.preview) {
    if (hasUrl) {
      sendPreviewLayout();
    }
    notifyNativePreviewNavigation(tab, previewTab, nextValue);
    setNativePreviewVisibility(hasUrl);
  } else if (isActivePreview && !hasUrl) {
    setNativePreviewVisibility(false);
  }
  updatePreviewNavigationControls();
}

export function refreshPreview(): void {
  const tab = getActiveMainTab();
  if (!tab || !previewHost) {
    return;
  }
  const previewTab = getActivePreviewTab(tab);
  if (!previewTab) {
    return;
  }
  const frame = ensurePreviewFrame(tab, previewTab);
  if (!frame) {
    return;
  }
  const stored = getStoredPreviewUrl(previewTab);
  frame.dataset['url'] = stored;
  if (tab.activePreviewTabId === previewTab.id && state.columnLayout.visibility.preview) {
    notifyNative('previewRefresh', {
      tabId: tab.id,
      previewTabId: previewTab.id,
      url: stored,
    });
  }
  updatePreviewNavigationControls();
}

export function handlePreviewSnapshotResult(payload: unknown): void {
  if (!previewSnapshotButton) {
    return;
  }
  const success = normaliseSnapshotResult(payload);
  const message = success ? SNAPSHOT_SUCCESS_MESSAGE : SNAPSHOT_FAILURE_MESSAGE;
  snapshotFeedback.show(success, message);
}

function shouldRefreshPanePreview(paneIndex: number, intervalMs = 2000): boolean {
  const now = Date.now();
  const last = lastPreviewRefreshByPane.get(paneIndex) ?? 0;
  if (now - last < intervalMs) {
    return false;
  }
  lastPreviewRefreshByPane.set(paneIndex, now);
  return true;
}

export function handleTerminalPreviewCandidate(tabIndex: number, paneIndex: number, rawUrl: string): void {
  const tab = state.tabs[tabIndex];
  if (!tab) {
    return;
  }

  const normalised = normalisePreviewUrl(rawUrl);
  if (!normalised) {
    return;
  }

  const incomingHost = extractHost(normalised);
  if (!incomingHost) {
    return;
  }

  const previewTabs = tab.previewTabs;
  let target = previewTabs.find((preview) => extractHost(getStoredPreviewUrl(preview)) === incomingHost) ?? null;

  if (!target) {
    target = getPreviewTabById(tab, tab.activePreviewTabId)
      ?? previewTabs[0]
      ?? createPreviewTabForTab(tab);
  }

  const storedUrl = getStoredPreviewUrl(target);
  const storedHost = extractHost(storedUrl);
  const sameUrl = storedUrl === normalised;
  const sameHost = storedHost === incomingHost;

  if (!tab.activePreviewTabId) {
    tab.activePreviewTabId = target.id;
  }

  const isActiveTab = state.activeTabIndex === tabIndex;

  if (isActiveTab) {
    if (tab.activePreviewTabId !== target.id) {
      tab.activePreviewTabId = target.id;
      updateActivePreview();
    }

    if (!sameUrl) {
      navigatePreview(normalised);
    } else if (sameHost && shouldRefreshPanePreview(paneIndex)) {
      const activeTab = getActiveMainTab();
      if (activeTab && activeTab.id === tab.id && tab.activePreviewTabId === target.id) {
        refreshPreview();
      }
    }
  } else {
    if (!sameUrl) {
      setStoredPreviewUrl(target, normalised);
      maybeUpdatePreviewTabTitle(tab, target, normalised);
    }
    if (tab.activePreviewTabId !== target.id) {
      tab.activePreviewTabId = target.id;
    }
    notifyNativePreviewUpdate(tab);
  }
}

function openPreviewInBrowser(): void {
  const tab = getActiveMainTab();
  if (!tab) {
    return;
  }
  const previewTab = getActivePreviewTab(tab);
  if (!previewTab) {
    return;
  }
  const rawInput = previewInput?.value ?? '';
  const candidate = normalisePreviewUrl(rawInput);
  const stored = getStoredPreviewUrl(previewTab);
  const targetUrl = candidate ?? stored;
  if (!targetUrl) {
    return;
  }
  notifyNative('previewOpenExternal', {
    tabId: tab.id,
    previewTabId: previewTab.id,
    url: targetUrl,
  });
}

export function registerPreviewControls(): void {
  if (previewBackButton) {
    if (!previewBackButton.querySelector('svg.icon')) {
      const backIcon = createIcon('arrowBack');
      if (backIcon) {
        previewBackButton.textContent = '';
        previewBackButton.appendChild(backIcon);
      } else if (!previewBackButton.textContent || previewBackButton.textContent.trim().length === 0) {
        previewBackButton.textContent = '←';
      }
    }
    previewBackButton.addEventListener('click', () => {
      goBackPreview();
    });
  }

  if (previewSnapshotButton) {
    let idleIcon = previewSnapshotButton.querySelector<SVGSVGElement>('svg.icon');
    if (!idleIcon) {
      const snapshotIcon = createIcon('camera');
      if (snapshotIcon) {
        previewSnapshotButton.textContent = '';
        previewSnapshotButton.appendChild(snapshotIcon);
        idleIcon = snapshotIcon;
      } else if (!previewSnapshotButton.textContent || previewSnapshotButton.textContent.trim().length === 0) {
        previewSnapshotButton.textContent = 'Copy';
      }
    }
    const idleText = idleIcon ? null : (previewSnapshotButton.textContent?.trim() || 'Copy');
    const successIcon = createIcon('check');
    const errorIcon = createIcon('close');
    const applyIcon = (icon: SVGSVGElement | null) => {
      if (icon) {
        previewSnapshotButton.textContent = '';
        previewSnapshotButton.appendChild(icon);
      } else if (idleText) {
        previewSnapshotButton.textContent = idleText;
      } else {
        previewSnapshotButton.textContent = '';
      }
    };
    snapshotFeedbackStateListener = (state: SnapshotFeedbackState) => {
      if (state === 'success') {
        applyIcon(successIcon ?? idleIcon);
        return;
      }
      if (state === 'error') {
        applyIcon(errorIcon ?? idleIcon);
        return;
      }
      applyIcon(idleIcon);
    };
    snapshotFeedbackStateListener('idle', previewSnapshotDefaultTitle);
    if (!previewSnapshotButton.title) {
      previewSnapshotButton.title = previewSnapshotDefaultTitle;
    }
    const existingLabel = previewSnapshotButton.getAttribute('aria-label');
    if (!existingLabel) {
      previewSnapshotButton.setAttribute('aria-label', previewSnapshotDefaultLabel);
    }
    snapshotFeedback.toIdle();
    previewSnapshotButton.addEventListener('click', () => {
      copyPreviewSnapshot();
    });
  }

  if (previewGoButton) {
    if (!previewGoButton.querySelector('svg.icon')) {
      const goIcon = createIcon('arrowForward');
      if (goIcon) {
        previewGoButton.textContent = '';
        previewGoButton.appendChild(goIcon);
      } else if (!previewGoButton.textContent || previewGoButton.textContent.trim().length === 0) {
        previewGoButton.textContent = '→';
      }
    }
    previewGoButton.addEventListener('click', () => {
      navigatePreview(previewInput?.value ?? '');
    });
  }

  if (previewRefreshButton) {
    if (!previewRefreshButton.querySelector('svg.icon')) {
      const refreshIcon = createIcon('refresh');
      if (refreshIcon) {
        previewRefreshButton.textContent = '';
        previewRefreshButton.appendChild(refreshIcon);
      } else if (!previewRefreshButton.textContent || previewRefreshButton.textContent.trim().length === 0) {
        previewRefreshButton.textContent = '⟳';
      }
    }
    previewRefreshButton.addEventListener('click', () => {
      refreshPreview();
    });
  }

  if (previewOpenExternalButton) {
    if (!previewOpenExternalButton.querySelector('svg.icon')) {
      const externalIcon = createIcon('openInNew');
      if (externalIcon) {
        previewOpenExternalButton.textContent = '';
        previewOpenExternalButton.appendChild(externalIcon);
      } else if (!previewOpenExternalButton.textContent || previewOpenExternalButton.textContent.trim().length === 0) {
        previewOpenExternalButton.textContent = '↗';
      }
    }
    previewOpenExternalButton.addEventListener('click', () => {
      openPreviewInBrowser();
    });
  }

  if (previewAddTabButton) {
    if (!previewAddTabButton.querySelector('svg.icon')) {
      const icon = createIcon('plus');
      if (icon) {
        previewAddTabButton.appendChild(icon);
      }
    }
    let label = previewAddTabButton.querySelector<HTMLSpanElement>('.button-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'button-label';
      previewAddTabButton.appendChild(label);
    }
    label.textContent = 'Add browser';
    previewAddTabButton.setAttribute('aria-label', 'Add browser');
    previewAddTabButton.title = 'Add browser';
    previewAddTabButton.addEventListener('click', () => {
      addPreviewTab();
    });
  }

  if (previewInput) {
    previewInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        navigatePreview(previewInput.value);
      }
    });
  }

  updatePreviewNavigationControls();
  ensurePreviewHostObserver();
  window.addEventListener('resize', () => {
    sendPreviewLayout();
  });
  window.requestAnimationFrame(() => {
    sendPreviewLayout();
  });
}

export function handlePreviewTabRemoval(tab: TabState): void {
  let removedActive = false;
  tab.previewTabs.forEach((previewTab) => {
    const frame = state.preview.frames.get(previewTab.id);
    if (frame) {
      frame.remove();
      state.preview.frames.delete(previewTab.id);
    }
    state.preview.urls.delete(previewTab.id);
    if (previewTab.id === state.preview.activePreviewTabId) {
      removedActive = true;
    }
  });
  if (removedActive) {
    state.preview.activePreviewTabId = null;
    resetPreviewNavigationState();
  }
  updatePreviewNavigationControls();
}

export function handlePreviewColumnVisibilityChange(visible: boolean): void {
  const tab = getActiveMainTab();
  const previewTab = getActivePreviewTab(tab);
  const storedUrl = tab && previewTab ? getStoredPreviewUrl(previewTab) : '';
  const hasUrl = storedUrl.length > 0;
  const shouldShow = Boolean(tab) && Boolean(previewTab) && visible && hasUrl;
  setNativePreviewVisibility(shouldShow);
  if (!shouldShow) {
    resetPreviewNavigationState();
  }
  if (tab && previewTab && visible) {
    window.requestAnimationFrame(() => {
      if (hasUrl) {
        sendPreviewLayout();
      }
      notifyNativePreviewNavigation(tab, previewTab, storedUrl);
    });
  }
}
