import { state } from './state.js';
import { notifyNative } from './nativeBridge.js';
import { noteUserInput, clearPendingUserInput } from './tabActivity.js';
import type { Terminal } from './types.js';

const encoder = new TextEncoder();
const isMacLike = typeof navigator !== 'undefined'
  && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const promptBuffers = new Map<number, string>();
const promptEscapeState = new Map<number, boolean>();

type OscColorTarget = 'foreground' | 'background' | 'cursor';

const OSC_COLOR_TARGETS: Record<number, OscColorTarget> = {
  10: 'foreground',
  11: 'background',
  12: 'cursor',
};

function toHexComponent(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0');
}

function convertRgbComponent(component: string): number | null {
  const trimmed = component.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[0-9a-fA-F]{1,4}$/u.test(trimmed)) {
    return null;
  }
  const value = parseInt(trimmed, 16);
  const bits = trimmed.length * 4;
  if (bits <= 0) {
    return null;
  }
  const max = (1 << bits) - 1;
  if (max <= 0) {
    return 0;
  }
  const scaled = (value / max) * 255;
  return Math.max(0, Math.min(255, Math.round(scaled)));
}

function normaliseRgbNotation(spec: string): string | null {
  const content = spec.slice(4);
  const [red, green, blue] = content.split('/', 3);
  if (!red || !green || !blue) {
    return null;
  }
  const r = convertRgbComponent(red);
  const g = convertRgbComponent(green);
  const b = convertRgbComponent(blue);
  if (r === null || g === null || b === null) {
    return null;
  }
  return `#${toHexComponent(r)}${toHexComponent(g)}${toHexComponent(b)}`;
}

function normaliseHashNotation(spec: string): string | null {
  const hex = spec.slice(1);
  if (!hex) {
    return null;
  }
  if (hex.length % 3 !== 0) {
    return null;
  }
  const segmentLength = hex.length / 3;
  if (segmentLength < 1 || segmentLength > 4) {
    return null;
  }
  const red = hex.slice(0, segmentLength);
  const green = hex.slice(segmentLength, segmentLength * 2);
  const blue = hex.slice(segmentLength * 2);
  const r = convertRgbComponent(red);
  const g = convertRgbComponent(green);
  const b = convertRgbComponent(blue);
  if (r === null || g === null || b === null) {
    return null;
  }
  return `#${toHexComponent(r)}${toHexComponent(g)}${toHexComponent(b)}`;
}

function normaliseOscColorPayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === '?') {
    return null;
  }
  if (trimmed.startsWith('rgb:')) {
    return normaliseRgbNotation(trimmed);
  }
  if (trimmed.startsWith('#')) {
    return normaliseHashNotation(trimmed);
  }
  return null;
}

function applyThemeToTerminal(term: Terminal, theme = state.terminalTheme): void {
  const applied: { foreground: string; background: string; cursor?: string } = {
    foreground: theme.foreground,
    background: theme.background,
  };
  if (theme.cursor) {
    applied.cursor = theme.cursor;
  }
  term.options.theme = {
    ...(term.options.theme ?? {}),
    ...applied,
  };
}

function updateTerminalTheme(target: OscColorTarget, color: string): void {
  if (state.terminalTheme[target] === color) {
    return;
  }
  state.terminalTheme[target] = color;
  state.terminals.forEach((terminal) => {
    applyThemeToTerminal(terminal);
  });
  if (target === 'background') {
    state.panes.forEach((pane) => {
      if (pane?.elements?.terminalContainer) {
        pane.elements.terminalContainer.style.backgroundColor = color;
      }
    });
  }
}

function applyOscColorSequence(startIdent: number, payload: string): void {
  let currentIdent = startIdent;
  const parts = payload.split(';');
  for (const part of parts) {
    const segment = part.trim();
    if (!segment) {
      continue;
    }
    if (/^\d+$/u.test(segment)) {
      currentIdent = Number(segment);
      continue;
    }
    const target = OSC_COLOR_TARGETS[currentIdent];
    if (!target) {
      continue;
    }
    const colour = normaliseOscColorPayload(segment);
    if (colour) {
      updateTerminalTheme(target, colour);
    }
  }
}

function registerOscColorHandlers(index: number, term: Terminal): void {
  const existing = state.oscHandlers.get(index);
  if (existing) {
    existing.forEach((dispose) => {
      try {
        dispose();
      } catch {
        // ignore disposal errors
      }
    });
  }

  const disposables: (() => void)[] = [];

  let parser: import('@xterm/xterm').IParser;
  try {
    parser = term.parser;
  } catch {
    state.oscHandlers.delete(index);
    return;
  }

  const register = (ident: number) => {
    const disposable = parser.registerOscHandler(ident, (raw: string) => {
      applyOscColorSequence(ident, raw);
      return true;
    });
    disposables.push(() => {
      try {
        disposable.dispose();
      } catch {
        // no-op
      }
    });
  };

  (Object.entries(OSC_COLOR_TARGETS)).forEach(([ident]) => {
    const numericIdent = Number(ident);
    if (Number.isFinite(numericIdent)) {
      register(numericIdent);
    }
  });

  if (disposables.length > 0) {
    state.oscHandlers.set(index, disposables);
  } else {
    state.oscHandlers.delete(index);
  }
}

function toBase64(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function binaryStringToBase64(value: string): string {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }

  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function ensureDecoder(index: number): TextDecoder {
  const existing = state.decoders.get(index);
  if (existing) {
    return existing;
  }
  const decoder = new TextDecoder();
  state.decoders.set(index, decoder);
  return decoder;
}

function resetDecoder(index: number): void {
  state.decoders.delete(index);
}

function isConversationSummaryTrackingEnabled(index: number): boolean {
  const pane = state.panes.get(index);
  const startupCommand = pane?.descriptor?.startupCommand?.trim() ?? '';
  const paneKind = pane?.descriptor?.kind ?? 'shell';
  const hasSummary = (pane?.descriptor?.conversationSummary?.trim().length ?? 0) > 0;
  return Boolean(
    pane
    && pane.descriptor.column === 'primary'
    && paneKind !== 'codex'
    && startupCommand.length > 0
    && state.settings.conversationSummarySource === 'localCommand'
    && state.settings.conversationSummaryCommand.length > 0
    && !hasSummary
  );
}

function resetConversationPromptTracking(index?: number): void {
  if (typeof index === 'number') {
    promptBuffers.delete(index);
    promptEscapeState.delete(index);
    return;
  }
  promptBuffers.clear();
  promptEscapeState.clear();
}

function submitConversationPrompt(index: number, prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return;
  }
  notifyNative('summarizePanePrompt', { index, prompt: trimmed });
}

function trackConversationPrompt(index: number, data: string): void {
  if (!isConversationSummaryTrackingEnabled(index)) {
    resetConversationPromptTracking(index);
    return;
  }

  let buffer = promptBuffers.get(index) ?? '';
  let isSkippingEscape = promptEscapeState.get(index) ?? false;

  for (const character of data) {
    if (isSkippingEscape) {
      if (/[A-Za-z~]/u.test(character)) {
        isSkippingEscape = false;
      }
      continue;
    }

    if (character === '\u001b') {
      isSkippingEscape = true;
      continue;
    }

    if (character === '\r' || character === '\n') {
      submitConversationPrompt(index, buffer);
      buffer = '';
      continue;
    }

    if (character === '\u007f' || character === '\b') {
      buffer = buffer.slice(0, -1);
      continue;
    }

    if (character === '\u0015' || character === '\u0003') {
      buffer = '';
      continue;
    }

    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20) {
      continue;
    }

    buffer += character;
    if (buffer.length > 4000) {
      buffer = buffer.slice(-4000);
    }
  }

  if (buffer.length > 0) {
    promptBuffers.set(index, buffer);
  } else {
    promptBuffers.delete(index);
  }

  if (isSkippingEscape) {
    promptEscapeState.set(index, true);
  } else {
    promptEscapeState.delete(index);
  }
}

export function fromBase64(index: number, base64: string): string {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const decoder = ensureDecoder(index);
  return decoder.decode(bytes, { stream: true });
}

function attachClipboardShortcuts(index: number, term: Terminal): void {
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const hasClipboardModifier = isMacLike ? event.metaKey : event.ctrlKey;
    if (!hasClipboardModifier) {
      return true;
    }

    if (key === 'c') {
      if (term.hasSelection()) {
        const text = term.getSelection();
        notifyNative('copy', { index, text });
        event.preventDefault();
        return false;
      }
      return true;
    }

    if (key === 'v') {
      notifyNative('requestPaste', { index });
      event.preventDefault();
      return false;
    }

    return true;
  });
}

function createTerminal(index: number, container: HTMLDivElement): Terminal {
  const TerminalCtor = window.Terminal;
  if (!TerminalCtor) {
    throw new Error('xterm runtime is not available');
  }
  const initialTheme = state.terminalTheme;
  const term = new TerminalCtor({
    cursorBlink: true,
    convertEol: false,
    allowProposedApi: true,
    theme: {
      background: initialTheme.background,
      foreground: initialTheme.foreground,
      cursor: initialTheme.cursor,
    },
  });

  if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    state.fitAddons.set(index, fitAddon);
  }

  term.open(container);
  container.style.backgroundColor = initialTheme.background;
  applyThemeToTerminal(term, initialTheme);
  registerOscColorHandlers(index, term);

  const refreshOnFocus = () => {
    scheduleFit(index);
  };

  let pointerDown = false;

  container.addEventListener('mousedown', () => {
    pointerDown = true;
    term.focus();
    notifyNative('focusPane', { index });
  });

  container.addEventListener('mouseup', () => {
    pointerDown = false;
  });

  container.addEventListener('mouseleave', () => {
    pointerDown = false;
  });

  container.addEventListener('focusin', () => {
    if (pointerDown) {
      pointerDown = false;
    } else {
      refreshOnFocus();
    }
    notifyNative('focusPane', { index });
  });

  term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      notifyNative('resize', { index, cols, rows });
    }
  });

  term.onData((data: string) => {
    notifyNative('send', { index, payload: toBase64(data) });
    noteUserInput(index, data);
    trackConversationPrompt(index, data);
  });

  term.onBinary((data: string) => {
    notifyNative('send', { index, payload: binaryStringToBase64(data) });
  });

  term.onTitleChange((title: string) => {
    if (typeof title !== 'string') {
      return;
    }
    const pane = state.panes.get(index);
    if (!pane) {
      return;
    }
    const trimmed = title.trim();
    const shouldForceSummaryRefresh = state.settings.conversationSummarySource === 'terminalTitle';
    if (trimmed && (trimmed !== pane.descriptor.title || shouldForceSummaryRefresh)) {
      notifyNative('renamePane', { index, title: trimmed });
    }
  });

  attachClipboardShortcuts(index, term);
  state.terminals.set(index, term);
  return term;
}

export function flushPendingPayload(index: number, terminal: Terminal): void {
  const buffered = state.pendingPayloads.get(index);
  if (buffered) {
    terminal.write(buffered);
    state.pendingPayloads.delete(index);
  }
}

export function ensureTerminal(index: number): Terminal | null {
  const existing = state.terminals.get(index);
  if (existing) {
    const pane = state.panes.get(index);
    if (pane) {
      pane.terminal = existing;
    }
    return existing;
  }
  const pane = state.panes.get(index);
  if (!pane) {
    return null;
  }
  const container = pane.elements.terminalContainer;
  const term = createTerminal(index, container);
  pane.terminal = term;
  flushPendingPayload(index, term);
  return term;
}

export function sendCommandToTerminal(index: number, command: string): void {
  const text = command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`;
  const terminal = ensureTerminal(index);
  notifyNative('send', { index, payload: toBase64(text) });
  noteUserInput(index, text);
  terminal?.focus();
}

export function disposeTerminal(index: number): void {
  const pane = state.panes.get(index);
  if (!pane) {
    return;
  }
  const terminal = pane.terminal;
  if (terminal) {
    const oscDisposables = state.oscHandlers.get(index);
    if (oscDisposables) {
      oscDisposables.forEach((dispose) => {
        try {
          dispose();
        } catch {
          // ignore
        }
      });
      state.oscHandlers.delete(index);
    }
    const fitAddon = state.fitAddons.get(index);
    if (fitAddon && typeof fitAddon.dispose === 'function') {
      fitAddon.dispose();
    }
    terminal.dispose();
    pane.terminal = null;
  }
  clearPendingUserInput(index);
  resetConversationPromptTracking(index);
  state.terminals.delete(index);
  state.fitAddons.delete(index);
  state.scheduledFits.delete(index);
  resetDecoder(index);
}

export { resetConversationPromptTracking };

const resizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const paneIndex = Number((entry.target as HTMLElement).dataset?.['paneIndex']);
        if (Number.isFinite(paneIndex)) {
          scheduleFit(paneIndex);
        }
      });
    })
  : null;

export function observePaneContainer(container: HTMLDivElement, index: number): void {
  if (resizeObserver && container) {
    resizeObserver.observe(container);
  }
  scheduleFit(index);
}

export function scheduleFit(index: number): void {
  if (state.scheduledFits.get(index)) {
    return;
  }
  state.scheduledFits.set(index, true);
  requestAnimationFrame(() => {
    state.scheduledFits.delete(index);
    fitTerminal(index);
  });
}

function fitTerminal(index: number): void {
  const pane = state.panes.get(index);
  if (!pane || pane.status !== 'connected') {
    return;
  }

  const terminal = pane.terminal;
  if (!terminal) {
    return;
  }

  const container = pane.elements.terminalContainer;
  if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
    return;
  }

  const fitAddon = state.fitAddons.get(index);
  if (fitAddon && typeof fitAddon.proposeDimensions === 'function') {
    const dims = fitAddon.proposeDimensions();
    if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
      if (dims.cols !== terminal.cols || dims.rows !== terminal.rows) {
        fitAddon.fit();
      }
      return;
    }
  }

  const terminalInternals = terminal as Terminal & {
    _core?: unknown;
    _coreService?: unknown;
    core?: unknown;
  };
  const core: any = terminalInternals._core ?? terminalInternals._coreService ?? terminalInternals.core;
  const renderService: any = core && (core._renderService || core._renderers || core._renderService?._renderer);
  const dimensions: any = renderService && (renderService.dimensions || renderService._dimensions || renderService._core?.dimensions);
  const cellWidth = dimensions?.css?.cell?.width
    || dimensions?.actualCellWidth
    || dimensions?.device?.cell?.width
    || dimensions?.scaledCellWidth;
  const cellHeight = dimensions?.css?.cell?.height
    || dimensions?.actualCellHeight
    || dimensions?.device?.cell?.height
    || dimensions?.scaledCellHeight;

  if (!cellWidth || !cellHeight) {
    return;
  }

  const cols = Math.max(2, Math.floor(container.clientWidth / cellWidth));
  const rows = Math.max(1, Math.floor(container.clientHeight / cellHeight));

  if (cols !== terminal.cols || rows !== terminal.rows) {
    terminal.resize(cols, rows);
  }
}
