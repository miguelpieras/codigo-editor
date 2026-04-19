let activeOverlay: HTMLDivElement | null = null;
let activeResolver: ((value: string[] | null) => void) | null = null;
let restoreBodyOverflow: string | null = null;

interface CommandManagerOptions {
  title: string;
  description: string;
  inputPlaceholder: string;
  addButtonLabel: string;
  clearButtonLabel: string;
  saveButtonLabel: string;
  cancelButtonLabel: string;
}

const defaultOptions: CommandManagerOptions = {
  title: 'Manage terminal commands',
  description: 'Commands appear in the stacked pane dropdown. Enter one per row.',
  inputPlaceholder: 'Enter command',
  addButtonLabel: 'Add command',
  clearButtonLabel: 'Clear all',
  saveButtonLabel: 'Save',
  cancelButtonLabel: 'Cancel',
};

function teardown(result: string[] | null): void {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  if (restoreBodyOverflow !== null) {
    document.body.style.overflow = restoreBodyOverflow;
    restoreBodyOverflow = null;
  }
  if (activeResolver) {
    const resolver = activeResolver;
    activeResolver = null;
    resolver(result);
  }
  document.removeEventListener('keydown', handleKeyDown, true);
}

function handleKeyDown(event: KeyboardEvent): void {
  if (!activeOverlay) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    teardown(null);
  }
}

function createRow(initialValue: string, list: HTMLDivElement, placeholder: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'command-manager-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'command-manager-input';
  input.value = initialValue;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'command-manager-remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    row.remove();
    if (!list.querySelector('.command-manager-row')) {
      list.appendChild(createRow('', list, placeholder));
    }
  });

  row.appendChild(input);
  row.appendChild(remove);
  return row;
}

function collectCommands(container: HTMLDivElement): string[] {
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input.command-manager-input'));
  const values = inputs
    .map((input) => input.value.trim())
    .filter((value) => value.length > 0);
  const seen = new Set<string>();
  const deduped: string[] = [];
  values.forEach((value) => {
    if (!seen.has(value)) {
      seen.add(value);
      deduped.push(value);
    }
  });
  return deduped;
}

export function openTerminalCommandManager(
  existing: string[],
  options: Partial<CommandManagerOptions> = {},
): Promise<string[] | null> {
  if (activeResolver) {
    teardown(null);
  }
  if (!document.body) {
    return Promise.resolve(null);
  }

  const config: CommandManagerOptions = { ...defaultOptions, ...options };

  const overlay = document.createElement('div');
  overlay.className = 'command-manager-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'command-manager-dialog';

  const title = document.createElement('h2');
  title.className = 'command-manager-title';
  title.textContent = config.title;

  const description = document.createElement('p');
  description.className = 'command-manager-description';
  description.textContent = config.description;

  const form = document.createElement('form');
  form.className = 'command-manager-form';

  const list = document.createElement('div');
  list.className = 'command-manager-list';

  const safeExisting = Array.isArray(existing)
    ? existing.filter((value) => typeof value === 'string')
    : [];

  if (safeExisting.length > 0) {
    safeExisting.forEach((value) => {
      list.appendChild(createRow(value, list, config.inputPlaceholder));
    });
  } else {
    list.appendChild(createRow('', list, config.inputPlaceholder));
  }

  const controls = document.createElement('div');
  controls.className = 'command-manager-secondary-actions';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'command-manager-add';
  addButton.textContent = config.addButtonLabel;
  addButton.addEventListener('click', () => {
    const row = createRow('', list, config.inputPlaceholder);
    list.appendChild(row);
    const input = row.querySelector<HTMLInputElement>('input.command-manager-input');
    requestAnimationFrame(() => {
      input?.focus();
    });
  });

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'command-manager-clear';
  clearButton.textContent = config.clearButtonLabel;
  clearButton.addEventListener('click', () => {
    list.innerHTML = '';
    list.appendChild(createRow('', list, config.inputPlaceholder));
    const firstInput = list.querySelector<HTMLInputElement>('input.command-manager-input');
    requestAnimationFrame(() => {
      firstInput?.focus();
    });
  });

  controls.appendChild(addButton);
  controls.appendChild(clearButton);

  const actions = document.createElement('div');
  actions.className = 'command-manager-actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'command-manager-cancel';
  cancelButton.textContent = config.cancelButtonLabel;
  cancelButton.addEventListener('click', () => {
    teardown(null);
  });

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'command-manager-save';
  saveButton.textContent = config.saveButtonLabel;

  actions.appendChild(cancelButton);
  actions.appendChild(saveButton);

  form.appendChild(list);
  form.appendChild(controls);
  form.appendChild(actions);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const commands = collectCommands(list);
    teardown(commands);
  });

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      teardown(null);
    }
  });

  dialog.appendChild(title);
  dialog.appendChild(description);
  dialog.appendChild(form);
  overlay.appendChild(dialog);

  document.body.appendChild(overlay);

  const previousOverflow = document.body.style.overflow;
  restoreBodyOverflow = previousOverflow || '';
  document.body.style.overflow = 'hidden';

  activeOverlay = overlay;

  document.addEventListener('keydown', handleKeyDown, true);

  const firstInput = list.querySelector<HTMLInputElement>('input.command-manager-input');
  requestAnimationFrame(() => {
    firstInput?.focus();
    firstInput?.select();
  });

  return new Promise<string[] | null>((resolve) => {
    activeResolver = resolve;
  });
}

export function openTerminalLinkManager(existing: string[]): Promise<string[] | null> {
  return openTerminalCommandManager(existing, {
    title: 'Manage terminal links',
    description: 'Links appear in the stacked pane dropdown. Enter one per row.',
    inputPlaceholder: 'https://example.com',
    addButtonLabel: 'Add link',
  });
}
