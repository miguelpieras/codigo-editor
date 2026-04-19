import type {
  PaneDescriptor,
  PaneStatus,
  TabState,
  PreviewTabState,
  PaneColumn,
  PaneKind,
  TabActivityState,
} from './types.js';
import { generateUUID, isValidUUID } from './uuid.js';

function pathBasename(path: unknown): string {
  if (typeof path !== 'string') {
    return '';
  }
  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  return segments.pop() ?? '';
}

export function normalisePaneTitle(index: number, rawTitle: unknown, workingDirectory: unknown): string {
  const trimmed = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const placeholder = `Terminal ${index + 1}`;
  if (trimmed && trimmed !== placeholder) {
    return trimmed;
  }
  const fromDirectory = pathBasename(workingDirectory);
  if (fromDirectory) {
    return fromDirectory;
  }
  return `Terminal ${index + 1}`;
}

export function isPaneStatus(value: unknown): value is PaneStatus {
  return value === 'connecting' || value === 'connected' || value === 'disconnected';
}

export function normaliseStoredPreviewURL(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim();
}

interface RawPaneDescriptor {
  id?: unknown;
  index?: unknown;
  title?: unknown;
  status?: unknown;
  workingDirectory?: unknown;
  startupCommand?: unknown;
  kind?: unknown;
  conversationSummary?: unknown;
  column?: unknown;
}

export function normalisePaneDescriptor(
  raw: unknown,
  fallbackColumn: PaneColumn = 'stacked',
): PaneDescriptor | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as RawPaneDescriptor;
  const index = Number(candidate.index);
  if (!Number.isFinite(index)) {
    return null;
  }
  const workingDirectory = typeof candidate.workingDirectory === 'string'
    ? candidate.workingDirectory.trim()
    : '';
  const title = normalisePaneTitle(index, candidate.title, workingDirectory);
  const status = isPaneStatus(candidate.status) ? candidate.status : 'connecting';
  const startupCommand = typeof candidate.startupCommand === 'string' ? candidate.startupCommand : '';
  const rawKind = typeof candidate.kind === 'string' ? candidate.kind.trim().toLowerCase() : '';
  const kind: PaneKind = rawKind === 'codex' || rawKind === 'claude' ? rawKind : 'shell';
  const conversationSummary = typeof candidate.conversationSummary === 'string'
    ? candidate.conversationSummary.trim()
    : '';
  const columnRaw = typeof candidate.column === 'string' ? candidate.column.trim().toLowerCase() : '';
  const column = columnRaw === 'primary' || columnRaw === 'stacked'
    ? columnRaw as PaneColumn
    : fallbackColumn;
  const rawId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const id = rawId || `pane-${index}`;
  return {
    id,
    index,
    title,
    status,
    workingDirectory,
    startupCommand,
    kind,
    conversationSummary,
    column,
  };
}

interface RawPreviewTabDescriptor {
  id?: unknown;
  title?: unknown;
  url?: unknown;
}

interface RawTabDescriptor {
  id?: unknown;
  title?: unknown;
  panes?: unknown;
  previewURL?: unknown;
  previewTabs?: unknown;
  activePreviewTabId?: unknown;
}

function ensurePreviewTabId(rawId: unknown, usedIds: Set<string>): string {
  const candidate = typeof rawId === 'string' ? rawId.trim() : '';
  if (candidate && isValidUUID(candidate) && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }
  let generated = generateUUID();
  while (usedIds.has(generated)) {
    generated = generateUUID();
  }
  usedIds.add(generated);
  return generated;
}

function normalisePreviewTabTitle(rawTitle: unknown, fallbackIndex: number): string {
  const trimmed = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (trimmed.length > 0) {
    return trimmed;
  }
  return `Preview ${fallbackIndex + 1}`;
}

function normalisePreviewTabUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') {
    return '';
  }
  return rawUrl.trim();
}

function normalisePreviewTabDescriptor(
  raw: unknown,
  fallbackIndex: number,
  usedIds: Set<string>,
): PreviewTabState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as RawPreviewTabDescriptor;
  const id = ensurePreviewTabId(candidate.id, usedIds);
  const title = normalisePreviewTabTitle(candidate.title, fallbackIndex);
  const url = normalisePreviewTabUrl(candidate.url);
  return { id, title, url };
}

export function normaliseTabDescriptor(raw: unknown, fallbackIndex: number): TabState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as RawTabDescriptor;
  const title = typeof candidate.title === 'string' && candidate.title.trim().length > 0
    ? candidate.title.trim()
    : `Tab ${fallbackIndex + 1}`;
  const rawId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const id = rawId && isValidUUID(rawId) ? rawId : generateUUID();
  const panes = Array.isArray(candidate.panes)
    ? candidate.panes
        .map((pane, paneIndex) => normalisePaneDescriptor(pane, paneIndex === 0 ? 'primary' : 'stacked'))
        .filter((paneDescriptor): paneDescriptor is PaneDescriptor => Boolean(paneDescriptor))
    : [];
  const usedPreviewTabIds = new Set<string>();
  let previewTabs: PreviewTabState[] = [];
  if (Array.isArray(candidate.previewTabs)) {
    previewTabs = candidate.previewTabs
      .map((tab, index) => normalisePreviewTabDescriptor(tab, index, usedPreviewTabIds))
      .filter((tab): tab is PreviewTabState => Boolean(tab));
  }

  const legacyPreviewURL = normaliseStoredPreviewURL(candidate.previewURL);
  if (previewTabs.length === 0) {
    const idForLegacy = ensurePreviewTabId(undefined, usedPreviewTabIds);
    previewTabs.push({
      id: idForLegacy,
      title: 'Preview 1',
      url: legacyPreviewURL,
    });
  } else if (legacyPreviewURL.length > 0) {
    const hasNonEmptyUrl = previewTabs.some((tab) => tab.url.length > 0);
    if (!hasNonEmptyUrl) {
      previewTabs = previewTabs.map((tab, index) => (index === 0
        ? { ...tab, url: legacyPreviewURL }
        : tab));
    }
  }

  const activePreviewCandidate = typeof candidate.activePreviewTabId === 'string'
    ? candidate.activePreviewTabId.trim()
    : '';
  const activePreviewTabId = activePreviewCandidate && usedPreviewTabIds.has(activePreviewCandidate)
    ? activePreviewCandidate
    : previewTabs[0]?.id ?? null;

  return {
    id,
    title,
    panes,
    previewTabs,
    activePreviewTabId,
    activity: 'loading',
  };
}

export function normaliseTabs(rawTabs: unknown): TabState[] {
  if (!Array.isArray(rawTabs)) {
    return [];
  }
  return rawTabs
    .map((tab, idx) => normaliseTabDescriptor(tab, idx))
    .filter((tab): tab is TabState => Boolean(tab))
    .map((tab, idx) => {
      const clonedPreviewTabs = tab.previewTabs.map((previewTab, previewIndex) => ({
        id: previewTab.id,
        title: previewTab.title || `Preview ${previewIndex + 1}`,
        url: normalisePreviewTabUrl(previewTab.url),
      }));
      const activePreview = tab.activePreviewTabId && clonedPreviewTabs.some((preview) => preview.id === tab.activePreviewTabId)
        ? tab.activePreviewTabId
        : clonedPreviewTabs[0]?.id ?? null;
      return {
        id: tab.id,
        title: tab.title || `Tab ${idx + 1}`,
        panes: tab.panes.map((pane) => ({ ...pane })),
        previewTabs: clonedPreviewTabs,
        activePreviewTabId: activePreview,
        activity: (tab.activity as TabActivityState | undefined) ?? 'loading',
      };
    });
}
