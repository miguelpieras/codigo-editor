import { state } from './state.js';
import { notifyNative } from './nativeBridge.js';
import type { GitFileDetail } from './types.js';

interface ModalState {
    index: number;
    overlay: HTMLDivElement;
    modal: HTMLDivElement;
    content: HTMLDivElement;
    keyHandler: (event: KeyboardEvent) => void;
    previewWasVisible: boolean;
}

type DiffLineType = 'addition' | 'deletion' | 'meta';

interface DiffLine {
    content: string;
    type: DiffLineType;
}

let currentModal: ModalState | null = null;
let modalIdCounter = 0;

function isPreviewVisible(): boolean {
    return Boolean(state.columnLayout.visibility.preview);
}

function formatPath(detail: GitFileDetail): string {
    if (detail.previousPath && detail.previousPath !== detail.path) {
        return `${detail.previousPath} -> ${detail.path}`;
    }
    return detail.path;
}

function formatCounts(insertions: number, deletions: number): string {
    return `+${Math.max(0, insertions)} -${Math.max(0, deletions)}`;
}

function formatChangeLabel(status: string): string {
    switch (status) {
        case 'added':
        case 'untracked':
            return 'Added';
        case 'deleted':
            return 'Deleted';
        case 'renamed':
            return 'Renamed';
        case 'copied':
            return 'Copied';
        default:
            return 'Edited';
    }
}

function buildDiffLines(diff: string): DiffLine[] {
    if (!diff) {
        return [];
    }

    const lines = diff.split(/\r?\n/);
    const result: DiffLine[] = [];
    const pendingDeletes: string[] = [];
    let skippedContext = false;

    const flushDeletes = (): void => {
        while (pendingDeletes.length > 0) {
            const removed = pendingDeletes.shift() ?? '';
            result.push({ content: removed, type: 'deletion' });
        }
    };

    const emitOmissionIfNeeded = (): void => {
        if (skippedContext) {
            result.push({ content: '…', type: 'meta' });
            skippedContext = false;
        }
    };

    for (const rawLine of lines) {
        if (rawLine.length === 0) {
            continue;
        }

        if (rawLine.startsWith('diff --')
            || rawLine.startsWith('index ')
            || rawLine.startsWith('old mode ')
            || rawLine.startsWith('new mode ')
            || rawLine.startsWith('deleted file mode ')
            || rawLine.startsWith('new file mode ')
            || rawLine.startsWith('similarity index ')
            || rawLine.startsWith('dissimilarity index ')
            || rawLine.startsWith('rename from ')
            || rawLine.startsWith('rename to ')) {
            continue;
        }

        if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
            continue;
        }

        if (rawLine.startsWith('@@')) {
            flushDeletes();
            emitOmissionIfNeeded();
            result.push({ content: rawLine, type: 'meta' });
            continue;
        }

        if (rawLine.startsWith('\\')) {
            emitOmissionIfNeeded();
            result.push({ content: rawLine, type: 'meta' });
            continue;
        }

        if (rawLine.startsWith('-')) {
            pendingDeletes.push(rawLine.slice(1));
            continue;
        }

        if (rawLine.startsWith('+')) {
            emitOmissionIfNeeded();
            const addition = rawLine.slice(1);
            if (pendingDeletes.length > 0) {
                flushDeletes();
                result.push({ content: addition, type: 'addition' });
            } else {
                result.push({ content: addition, type: 'addition' });
            }
            continue;
        }

        if (rawLine.startsWith(' ')) {
            flushDeletes();
            skippedContext = true;
            continue;
        }

        flushDeletes();
        emitOmissionIfNeeded();
        result.push({ content: rawLine, type: 'meta' });
    }

    flushDeletes();
    emitOmissionIfNeeded();
    return result;
}

function renderDiff(detail: GitFileDetail): HTMLElement {
    const container = document.createElement('div');
    container.className = 'git-details-diff';

    const rows = buildDiffLines(detail.diff);
    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'git-details-status';
        empty.textContent = 'No textual diff available.';
        container.appendChild(empty);
        return container;
    }

    const block = document.createElement('div');
    block.className = 'git-diff-block';

    rows.forEach((row) => {
        const rowElement = document.createElement('div');
        rowElement.className = `git-diff-line git-diff-${row.type}`;

        const marker = document.createElement('span');
        marker.className = 'git-diff-marker';
        if (row.type === 'addition') {
            marker.textContent = '+';
        } else if (row.type === 'deletion') {
            marker.textContent = '-';
        } else if (row.content === '…') {
            marker.textContent = '·';
        } else {
            marker.textContent = '@';
        }

        const text = document.createElement('code');
        text.className = 'git-diff-text';
        text.textContent = row.content;

        rowElement.appendChild(marker);
        rowElement.appendChild(text);
        block.appendChild(rowElement);
    });

    container.appendChild(block);
    return container;
}

function renderFileDetail(detail: GitFileDetail): HTMLElement {
    const item = document.createElement('div');
    item.className = 'git-details-item';

    const headerButton = document.createElement('button');
    headerButton.type = 'button';
    headerButton.className = 'git-details-item-header';
    headerButton.setAttribute('aria-expanded', 'false');

    const bullet = document.createElement('span');
    bullet.className = 'git-details-item-bullet';
    bullet.textContent = '•';
    headerButton.appendChild(bullet);

    const kindLabel = document.createElement('span');
    kindLabel.className = `git-details-item-kind git-status-${detail.status}`;
    kindLabel.textContent = formatChangeLabel(detail.status);
    headerButton.appendChild(kindLabel);

    const pathLabel = document.createElement('span');
    pathLabel.className = 'git-details-item-path';
    pathLabel.textContent = formatPath(detail);
    headerButton.appendChild(pathLabel);

    const countsLabel = document.createElement('span');
    countsLabel.className = 'git-details-item-counts';
    countsLabel.textContent = formatCounts(detail.insertions, detail.deletions);
    headerButton.appendChild(countsLabel);

    item.appendChild(headerButton);

    const body = document.createElement('div');
    body.className = 'git-details-item-body';
    body.hidden = true;

    const diffNode = renderDiff(detail);
    body.appendChild(diffNode);
    item.appendChild(body);

    const toggle = (): void => {
        const willShow = body.hidden;
        body.hidden = !willShow;
        headerButton.setAttribute('aria-expanded', willShow ? 'true' : 'false');
        item.classList.toggle('expanded', willShow);
    };

    headerButton.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle();
    });

    headerButton.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            toggle();
        }
    });

    return item;
}

function createLoadingNode(): HTMLDivElement {
    const loading = document.createElement('div');
    loading.className = 'git-details-status';
    loading.textContent = 'Loading changes…';
    return loading;
}

export function closeGitDetailsModal(): void {
    if (!currentModal) {
        return;
    }

    const { overlay, keyHandler, previewWasVisible } = currentModal;
    document.removeEventListener('keydown', keyHandler);
    overlay.remove();
    currentModal = null;

    if (previewWasVisible) {
        notifyNative('previewVisibility', { visible: true });
    }
}

export function openGitDetailsModal(index: number): void {
    if (currentModal && currentModal.index === index) {
        closeGitDetailsModal();
        return;
    }
    closeGitDetailsModal();

    const overlay = document.createElement('div');
    overlay.className = 'git-details-overlay';

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeGitDetailsModal();
        }
    });

    const modal = document.createElement('div');
    modal.className = 'git-details-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const titleId = `git-details-title-${modalIdCounter += 1}`;
    modal.setAttribute('aria-labelledby', titleId);

    const header = document.createElement('div');
    header.className = 'git-details-header';

    const title = document.createElement('h2');
    title.className = 'git-details-title';
    title.id = titleId;
    title.textContent = 'Pending Changes';
    header.appendChild(title);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'git-details-close';
    closeButton.setAttribute('aria-label', 'Close pending changes');
    closeButton.addEventListener('click', () => closeGitDetailsModal());
    closeButton.textContent = 'x';
    header.appendChild(closeButton);

    modal.appendChild(header);

    const content = document.createElement('div');
    content.className = 'git-details-content';
    content.appendChild(createLoadingNode());
    modal.appendChild(content);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const keyHandler = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeGitDetailsModal();
        }
    };

    document.addEventListener('keydown', keyHandler);

    const previewWasVisible = isPreviewVisible();
    if (previewWasVisible) {
        notifyNative('previewVisibility', { visible: false });
    }

    currentModal = {
        index,
        overlay,
        modal,
        content,
        keyHandler,
        previewWasVisible,
    };

    modal.tabIndex = -1;
    modal.focus({ preventScroll: true });

    notifyNative('gitDetails', { index });
}

export function applyGitDetails(index: number, files: GitFileDetail[], error?: string | null): void {
    if (!currentModal || currentModal.index !== index) {
        return;
    }

    const { content } = currentModal;
    content.textContent = '';

    if (error && error.trim().length > 0) {
        const errorNode = document.createElement('div');
        errorNode.className = 'git-details-status git-details-error';
        errorNode.textContent = error;
        content.appendChild(errorNode);
        return;
    }

    if (files.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'git-details-status';
        empty.textContent = 'No pending changes.';
        content.appendChild(empty);
        return;
    }

    const list = document.createElement('div');
    list.className = 'git-details-list';

    files.forEach((detail) => {
        list.appendChild(renderFileDetail(detail));
    });

    content.appendChild(list);
}
