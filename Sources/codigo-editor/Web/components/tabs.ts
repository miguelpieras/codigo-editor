import { state } from './state.js';
import { tabBarTabs } from './dom.js';
import { notifyNative, postLog } from './nativeBridge.js';
import { copyTextToClipboard } from './clipboard.js';
import { showContextMenu } from './contextMenu.js';
import { updateVisiblePanes, focusFirstTerminal, updateWorkspaceEmptyState } from './panes.js';
import { clearPaneLayout } from './paneLayout.js';
import { updateActivePreview, handlePreviewTabRemoval } from './preview.js';
import { scheduleFit, disposeTerminal } from './terminals.js';
import { createIcon } from './icons.js';
import {
  handleTabRemoved,
  registerTabElement,
  resetTabElementRegistry,
} from './tabActivity.js';
import {
  applyColumnLayoutForTab,
  rememberActiveColumnLayoutState,
  removeTabLayout,
} from './columnLayout.js';

function clearTabDropIndicators(): void {
  const tabs = tabBarTabs.querySelectorAll<HTMLDivElement>('.tab[data-drop-position]');
  tabs.forEach((tab) => {
    tab.removeAttribute('data-drop-position');
  });
}

function requestNewTab(): void {
  notifyNative('newTab', {});
}

function requestCloseTab(index: number): void {
  const tab = state.tabs[index];
  if (!tab) {
    return;
  }
  notifyNative('closeTab', { index, id: tab.id });
}

function copyTabWorkingDirectory(index: number): void {
  const tab = state.tabs[index];
  if (!tab) {
    return;
  }
  const primaryPane = tab.panes.find((pane) => pane.column === 'primary') ?? tab.panes[0];
  const workingDirectory = typeof primaryPane?.workingDirectory === 'string'
    ? primaryPane.workingDirectory
    : '';
  copyTextToClipboard(workingDirectory);
}

export function updateTabBarActiveState(): void {
  const buttons = Array.from(tabBarTabs.querySelectorAll('.tab'));
  buttons.forEach((button, index) => {
    button.classList.toggle('active', index === state.activeTabIndex);
  });
}

export function selectTab(index: number, { force = false }: { force?: boolean } = {}): void {
  if (index < 0 || index >= state.tabs.length) {
    return;
  }
  if (!force && index === state.activeTabIndex) {
    return;
  }
  rememberActiveColumnLayoutState();
  state.activeTabIndex = index;
  updateTabBarActiveState();
  const activeTab = state.tabs[index];
  applyColumnLayoutForTab(activeTab?.id ?? null);
  rememberActiveColumnLayoutState(activeTab?.id ?? null);
  updateVisiblePanes();
  focusFirstTerminal();
  updateActivePreview();

  if (activeTab) {
    activeTab.panes.forEach((pane) => {
      scheduleFit(pane.index);
    });
  }
}

function finishTabRename(
  tabElement: HTMLDivElement,
  input: HTMLInputElement,
  index: number,
  commit: boolean,
): void {
  tabElement.classList.remove('editing');
  input.remove();

  if (!commit) {
    return;
  }

  const trimmed = input.value.trim();
  const currentTitle = state.tabs[index]?.title ?? '';
  if (!trimmed || !state.tabs[index]) {
    const titleEl = tabElement.querySelector('.title');
    if (titleEl && currentTitle.length > 0) {
      titleEl.textContent = currentTitle;
    }
    return;
  }

  if (state.tabs[index].title !== trimmed) {
    state.tabs[index].title = trimmed;
    const titleEl = tabElement.querySelector('.title');
    if (titleEl) {
      titleEl.textContent = trimmed;
    }
    const renamedTab = state.tabs[index];
    renamedTab.previewTabs.forEach((previewTab) => {
      const previewFrameForTab = state.preview.frames.get(previewTab.id);
      if (previewFrameForTab) {
        previewFrameForTab.title = `Preview — ${trimmed} — ${previewTab.title}`;
      }
    });
    notifyNative('renameTab', { index, title: trimmed });
    postLog({ type: 'tab-rename', index, title: trimmed });
  }
}

function beginRenameTab(tabElement: HTMLDivElement, index: number): void {
  if (tabElement.classList.contains('editing')) {
    return;
  }

  const currentTitle = state.tabs[index]?.title ?? '';
  tabElement.classList.add('editing');

  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.value = currentTitle;
  const closeButton = tabElement.querySelector('.tab-close-button');
  if (closeButton) {
    tabElement.insertBefore(input, closeButton);
  } else {
    tabElement.appendChild(input);
  }
  input.focus();
  input.select();

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finishTabRename(tabElement, input, index, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishTabRename(tabElement, input, index, false);
    }
  });

  input.addEventListener('blur', () => {
    finishTabRename(tabElement, input, index, true);
  });
}

export function renderTabBar(): void {
  tabBarTabs.innerHTML = '';
  resetTabElementRegistry();

  state.tabs.forEach((tab, index) => {
    const element = document.createElement('div');
    element.className = 'tab';
    element.setAttribute('draggable', 'true');

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title;
    element.appendChild(title);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'tab-close-button';
    closeButton.title = 'Close tab';
    closeButton.setAttribute('aria-label', 'Close tab');
    const closeIcon = createIcon('close');
    if (closeIcon) {
      closeButton.appendChild(closeIcon);
    } else {
      closeButton.textContent = '×';
    }
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      requestCloseTab(index);
    });
    element.appendChild(closeButton);

    element.addEventListener('click', () => selectTab(index));
    element.addEventListener('dblclick', () => beginRenameTab(element, index));
    element.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTab(index);
      } else if (event.key.toLowerCase() === 'r' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        beginRenameTab(element, index);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        requestCloseTab(index);
      }
    });

    element.addEventListener('contextmenu', (event: MouseEvent) => {
      showContextMenu(event, [
        {
          label: 'Copy Path',
          action: () => copyTabWorkingDirectory(index),
        },
      ]);
    });

    element.addEventListener('dragstart', (event: DragEvent) => {
      state.draggingTabId = tab.id;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tab.id);
      }
      clearTabDropIndicators();
      element.classList.add('dragging');
    });

    element.addEventListener('dragend', () => {
      state.draggingTabId = null;
      element.classList.remove('dragging');
      clearTabDropIndicators();
    });

    element.addEventListener('dragover', (event: DragEvent) => {
      if (!state.draggingTabId) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }

      const rect = element.getBoundingClientRect();
      const dropAfter = event.clientX > rect.left + rect.width / 2;
      clearTabDropIndicators();
      element.dataset['dropPosition'] = dropAfter ? 'after' : 'before';
    });

    element.addEventListener('dragleave', (event: DragEvent) => {
      const related = event.relatedTarget as Node | null;
      if (related && element.contains(related)) {
        return;
      }
      element.removeAttribute('data-drop-position');
    });

    element.addEventListener('drop', (event: DragEvent) => {
      event.preventDefault();
      const draggingId = state.draggingTabId ?? event.dataTransfer?.getData('text/plain');
      state.draggingTabId = null;
      clearTabDropIndicators();
      if (!draggingId || draggingId === tab.id) {
        return;
      }
      const fromIndex = state.tabs.findIndex((t) => t.id === draggingId);
      const targetIndex = state.tabs.findIndex((t) => t.id === tab.id);
      if (fromIndex === -1 || targetIndex === -1) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const dropAfter = event.clientX > rect.left + rect.width / 2;
      let insertionIndex = targetIndex + (dropAfter ? 1 : 0);
      if (fromIndex < insertionIndex) {
        insertionIndex -= 1;
      }
      reorderTabs(fromIndex, insertionIndex);
    });

    registerTabElement(tab.id, element);
    tabBarTabs.appendChild(element);
  });

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'add-tab-button';
  const addIcon = createIcon('plus');
  if (addIcon) {
    addButton.appendChild(addIcon);
  }
  const addLabel = document.createElement('span');
  addLabel.className = 'button-label';
  addLabel.textContent = 'Add project';
  addButton.appendChild(addLabel);
  addButton.title = 'Add project';
  addButton.setAttribute('aria-label', 'Add project');
  addButton.addEventListener('click', requestNewTab);
  tabBarTabs.appendChild(addButton);

  updateWorkspaceEmptyState();
}

function reorderTabs(fromIndex: number, toIndex: number): void {
  const tabs = state.tabs;
  if (fromIndex < 0 || fromIndex >= tabs.length) {
    return;
  }

  if (!Number.isFinite(toIndex)) {
    return;
  }
  let targetIndex = Math.trunc(toIndex);
  if (targetIndex < 0) {
    targetIndex = 0;
  }
  if (targetIndex > tabs.length) {
    targetIndex = tabs.length;
  }

  const activeTabId = state.tabs[state.activeTabIndex]?.id;
  const [moved] = tabs.splice(fromIndex, 1);
  if (!moved) {
    return;
  }

  if (targetIndex > tabs.length) {
    targetIndex = tabs.length;
  }

  tabs.splice(targetIndex, 0, moved);

  if (activeTabId) {
    const newActiveIndex = state.tabs.findIndex((tab) => tab.id === activeTabId);
    if (newActiveIndex >= 0) {
      state.activeTabIndex = newActiveIndex;
    }
  }

  state.draggingTabId = null;

  state.tabs.forEach((tab, idx) => {
    tab.panes.forEach((pane) => {
      const paneState = state.panes.get(pane.index);
      if (paneState) {
        paneState.tabIndex = idx;
        paneState.elements.container.dataset['tabIndex'] = String(idx);
      }
    });
  });

  renderTabBar();
  updateTabBarActiveState();
  updateVisiblePanes();
  updateActivePreview();

  notifyNative('reorderTabs', {
    order: state.tabs.map((tab) => tab.id),
    activeTabIndex: state.activeTabIndex,
  });
}

export function removeTabAt(index: number, { activeTabIndex }: { activeTabIndex?: number } = {}): boolean {
  if (index < 0 || index >= state.tabs.length) {
    return false;
  }
  const wasActiveTab = index === state.activeTabIndex;
  if (wasActiveTab) {
    rememberActiveColumnLayoutState();
  }
  const [removed] = state.tabs.splice(index, 1);
  if (!removed) {
    return false;
  }
  handleTabRemoved(removed.id, removed.title);
  removeTabLayout(removed.id);
  clearPaneLayout(removed.id);

  handlePreviewTabRemoval(removed);
  state.maximizedPaneByTab.delete(removed.id);
  state.focusedPrimaryPaneByTab.delete(removed.id);

  removed.panes.forEach((pane) => {
    const paneState = state.panes.get(pane.index);
    if (paneState) {
      disposeTerminal(pane.index);
      paneState.elements.container.remove();
    }
    state.panes.delete(pane.index);
    state.unreadPrimaryOutputByPane.delete(pane.index);
    state.pendingPayloads.delete(pane.index);
    state.scheduledFits.delete(pane.index);
    state.decoders.delete(pane.index);
  });

  if (typeof activeTabIndex === 'number' && Number.isFinite(activeTabIndex)) {
    state.activeTabIndex = Math.max(0, Math.min(activeTabIndex, Math.max(state.tabs.length - 1, 0)));
  } else if (state.activeTabIndex >= state.tabs.length) {
    state.activeTabIndex = Math.max(0, state.tabs.length - 1);
  } else if (wasActiveTab) {
    state.activeTabIndex = Math.min(state.activeTabIndex, Math.max(state.tabs.length - 1, 0));
  }

  state.tabs.forEach((tab, tabIndex) => {
    tab.panes.forEach((pane) => {
      const paneState = state.panes.get(pane.index);
      if (!paneState) {
        return;
      }
      paneState.tabIndex = tabIndex;
      paneState.elements.container.dataset['tabIndex'] = String(tabIndex);
    });
  });

  renderTabBar();
  updateTabBarActiveState();
  const activeTab = state.tabs[state.activeTabIndex];
  applyColumnLayoutForTab(activeTab?.id ?? null);
  rememberActiveColumnLayoutState(activeTab?.id ?? null);
  updateVisiblePanes();
  focusFirstTerminal();
  updateActivePreview();
  return true;
}
