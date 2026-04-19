import {
  syncAllButton,
  undoAllButton,
  primaryAddTerminalButton,
  stackedAddTerminalButton,
  stackedNewFolderButton,
} from './dom.js';
import { createIcon } from './icons.js';
import {
  syncMiddleColumnTerminals,
  undoMiddleColumnTerminals,
  requestAddPane,
} from './panes.js';
import { state } from './state.js';
import { notifyNative } from './nativeBridge.js';
import { confirmAction } from './confirmDialog.js';

let initialised = false;

function resolveCloudActionLabel(): string {
  switch (state.settings.terminalCloudAction) {
    case 'createPullRequest':
      return 'Create pull request for all terminals';
    case 'customScript':
      return 'Run custom script for all terminals';
    default:
      return 'Commit and push pending changes for all terminals';
  }
}

export function refreshGitHubControls(): void {
  const connected = state.settings.githubAccountConnected;
  const action = state.settings.terminalCloudAction;
  const requiresGitHub = action !== 'customScript';
  const scriptConfigured = action !== 'customScript'
    || (typeof state.settings.terminalCloudCustomScript === 'string'
      && state.settings.terminalCloudCustomScript.trim().length > 0);
  const label = resolveCloudActionLabel();

  const disabledForAuth = requiresGitHub && !connected;
  const disabledForConfig = !scriptConfigured;
  const tooltip = disabledForConfig
    ? 'Configure a custom script in Settings to enable this action'
    : disabledForAuth
      ? 'Sign in with the GitHub CLI to sync changes'
      : label;

  syncAllButton.setAttribute('aria-label', label);
  syncAllButton.title = tooltip;
  syncAllButton.disabled = disabledForAuth || disabledForConfig;
  syncAllButton.classList.toggle('hidden', requiresGitHub && !connected);
  syncAllButton.classList.toggle('requires-auth', disabledForAuth);
  syncAllButton.classList.toggle('requires-config', disabledForConfig);
  syncAllButton.setAttribute('aria-hidden', requiresGitHub && !connected ? 'true' : 'false');

  undoAllButton.disabled = !connected;
  undoAllButton.classList.toggle('hidden', !connected);
  undoAllButton.setAttribute('aria-hidden', connected ? 'false' : 'true');
}

async function promptForFolderName(defaultName: string): Promise<string | null> {
  const builtin = typeof window.prompt === 'function'
    ? window.prompt('Folder name', defaultName)
    : null;
  if (builtin !== null) {
    return builtin.trim();
  }

  if (!document.body) {
    return null;
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.background = 'rgba(0,0,0,0.45)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';

    const dialog = document.createElement('div');
    dialog.style.minWidth = '280px';
    dialog.style.maxWidth = '360px';
    dialog.style.background = '#1e1e1e';
    dialog.style.borderRadius = '12px';
    dialog.style.boxShadow = '0 18px 48px rgba(0,0,0,0.6)';
    dialog.style.padding = '20px';
    dialog.style.display = 'flex';
    dialog.style.flexDirection = 'column';
    dialog.style.gap = '12px';

    const title = document.createElement('h2');
    title.textContent = 'Create folder';
    title.style.margin = '0';
    title.style.fontSize = '16px';
    title.style.fontWeight = '600';
    title.style.color = 'rgba(255,255,255,0.95)';

    const label = document.createElement('label');
    label.textContent = 'Folder name';
    label.style.fontSize = '13px';
    label.style.fontWeight = '500';
    label.style.color = 'rgba(255,255,255,0.75)';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultName;
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.padding = '8px 10px';
    input.style.borderRadius = '8px';
    input.style.border = '1px solid rgba(255,255,255,0.25)';
    input.style.background = 'rgba(20,20,20,0.9)';
    input.style.color = 'rgba(255,255,255,0.95)';
    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.justifyContent = 'flex-end';
    buttons.style.gap = '10px';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.background = 'transparent';
    cancel.style.border = '1px solid rgba(255,255,255,0.25)';
    cancel.style.borderRadius = '8px';
    cancel.style.color = 'rgba(255,255,255,0.8)';
    cancel.style.padding = '6px 12px';

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = 'Create';
    confirm.style.background = 'rgba(80,160,255,0.25)';
    confirm.style.border = '1px solid rgba(80,160,255,0.45)';
    confirm.style.borderRadius = '8px';
    confirm.style.color = 'rgba(255,255,255,0.95)';
    confirm.style.padding = '6px 14px';

    function teardown(result: string | null): void {
      document.removeEventListener('keydown', handleKey);
      overlay.remove();
      resolve(result);
    }

    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        teardown(null);
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        confirm.click();
      }
    }

    cancel.addEventListener('click', () => teardown(null));
    confirm.addEventListener('click', () => {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      teardown(value);
    });

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        teardown(null);
      }
    });

    document.addEventListener('keydown', handleKey);

    buttons.appendChild(cancel);
    buttons.appendChild(confirm);
    dialog.appendChild(title);
    dialog.appendChild(label);
    dialog.appendChild(input);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(0, input.value.length);
    });
  });
}

function ensurePlusButtonContent(button: HTMLButtonElement, label: string): void {
  if (!button.querySelector('svg.icon')) {
    const icon = createIcon('plus');
    if (icon) {
      button.insertBefore(icon, button.firstChild);
    }
  }

  let text = button.querySelector<HTMLSpanElement>('.button-label');
  if (!text) {
    text = document.createElement('span');
    text.className = 'button-label';
    button.appendChild(text);
  }
  text.textContent = label;
}

export function initialiseColumnActions(): void {
  if (initialised) {
    return;
  }
  initialised = true;

  const existingIcon = syncAllButton.querySelector('svg.icon');
  if (!existingIcon) {
    const icon = createIcon('gitPush');
    if (icon) {
      syncAllButton.insertBefore(icon, syncAllButton.firstChild);
    }
  }

  syncAllButton.addEventListener('click', () => {
    if (!state.settings.githubAccountConnected) {
      syncAllButton.blur();
      return;
    }
    syncMiddleColumnTerminals();
    syncAllButton.blur();
  });

  const existingUndoIcon = undoAllButton.querySelector('svg.icon');
  if (!existingUndoIcon) {
    const icon = createIcon('undo');
    if (icon) {
      undoAllButton.insertBefore(icon, undoAllButton.firstChild);
    }
  }

  const undoAllLabel = 'Reset repositories and delete untracked files and folders for all terminals';
  undoAllButton.setAttribute('aria-label', undoAllLabel);
  undoAllButton.title = undoAllLabel;
  undoAllButton.addEventListener('click', () => {
    void (async () => {
      if (!state.settings.githubAccountConnected) {
        undoAllButton.blur();
        return;
      }
      const activeTab = state.tabs[state.activeTabIndex];
      const tabTitle = activeTab?.title?.trim?.() ?? '';
      const scope = tabTitle.length > 0 ? `"${tabTitle}"` : 'this tab';
      const confirmed = await confirmAction({
        title: 'Reset Repositories',
        message: `Reset all repositories in ${scope} to HEAD and delete untracked files and folders?`,
        confirmLabel: 'Reset & Delete',
        cancelLabel: 'Cancel',
        dangerous: true,
      });
      if (!confirmed) {
        return;
      }
      undoMiddleColumnTerminals();
      undoAllButton.blur();
    })();
  });

  ensurePlusButtonContent(primaryAddTerminalButton, 'Add agent');
  primaryAddTerminalButton.setAttribute('aria-label', 'Add agent');
  primaryAddTerminalButton.title = 'Add agent';
  primaryAddTerminalButton.addEventListener('click', () => {
    requestAddPane('primary');
    primaryAddTerminalButton.blur();
  });

  ensurePlusButtonContent(stackedAddTerminalButton, 'Add terminal');
  stackedAddTerminalButton.setAttribute('aria-label', 'Add terminal');
  stackedAddTerminalButton.title = 'Add terminal';
  stackedAddTerminalButton.addEventListener('click', () => {
    requestAddPane('stacked');
    stackedAddTerminalButton.blur();
  });

  ensurePlusButtonContent(stackedNewFolderButton, 'Add folder');
  stackedNewFolderButton.setAttribute('aria-label', 'Add folder');
  stackedNewFolderButton.title = 'Add folder';
  stackedNewFolderButton.addEventListener('click', () => {
    void (async () => {
      const activeTabIndex = state.activeTabIndex;
      const activeTab = state.tabs[activeTabIndex];
      if (!activeTab) {
        window.alert('No tab is active to create a folder.');
        return;
      }

      const primaryDescriptor = activeTab.panes.find((pane) => pane.column === 'primary') ?? activeTab.panes[0];
      const baseDirectory = typeof primaryDescriptor?.workingDirectory === 'string'
        ? primaryDescriptor.workingDirectory.trim()
        : '';
      if (!baseDirectory) {
        window.alert('No working directory is available to create a folder.');
        return;
      }

      const suggested = 'New Folder';
      const input = await promptForFolderName(suggested);
      if (input === null) {
        return;
      }
      const trimmed = input.trim();
      if (/[\\/:]/.test(trimmed)) {
        window.alert('Folder name cannot contain /, \\ or : characters.');
        return;
      }
      if (trimmed.length > 128) {
        window.alert('Folder name must be 128 characters or fewer.');
        return;
      }

      notifyNative('createFolder', {
        tabId: activeTab.id,
        tabIndex: activeTabIndex,
        baseDirectory,
        column: 'stacked',
        name: trimmed,
      });
      stackedNewFolderButton.blur();
    })();
  });

  refreshGitHubControls();
}
