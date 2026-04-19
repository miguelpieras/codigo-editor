interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  dangerous?: boolean;
}

export function confirmAction(options: ConfirmDialogOptions): Promise<boolean> {
  const {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    dangerous = false,
  } = options;

  if (!document.body) {
    const fallback = typeof window.confirm === 'function'
      ? window.confirm(message)
      : true;
    return Promise.resolve(fallback);
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirmation-overlay';

    const modal = document.createElement('div');
    modal.className = 'confirmation-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const titleId = `confirmation-title-${Math.random().toString(16).slice(2)}`;
    modal.setAttribute('aria-labelledby', titleId);

    const heading = document.createElement('h2');
    heading.className = 'confirmation-title';
    heading.id = titleId;
    heading.textContent = title;
    modal.appendChild(heading);

    const body = document.createElement('p');
    body.className = 'confirmation-message';
    body.textContent = message;
    modal.appendChild(body);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'confirmation-buttons';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'confirmation-button confirmation-button--cancel';
    cancelButton.textContent = cancelLabel;

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'confirmation-button confirmation-button--confirm';
    if (dangerous) {
      confirmButton.classList.add('is-danger');
    }
    confirmButton.textContent = confirmLabel;

    function teardown(result: boolean): void {
      document.removeEventListener('keydown', handleKeyDown, true);
      overlay.remove();
      resolve(result);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        teardown(false);
      }
      if (event.key === 'Enter' && document.activeElement === confirmButton) {
        event.preventDefault();
        teardown(true);
      }
    }

    cancelButton.addEventListener('click', () => teardown(false));
    confirmButton.addEventListener('click', () => teardown(true));

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        teardown(false);
      }
    });

    overlay.appendChild(modal);
    buttonRow.appendChild(cancelButton);
    buttonRow.appendChild(confirmButton);
    modal.appendChild(buttonRow);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', handleKeyDown, true);

    requestAnimationFrame(() => {
      confirmButton.focus({ preventScroll: true });
    });
  });
}
