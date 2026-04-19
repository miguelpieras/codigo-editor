import { copyTextToClipboard } from './clipboard.js';
import { notifyNative } from './nativeBridge.js';
import type { PaneState, PaneGitHubActionStatus, GitHubActionJobSummary } from './types.js';

interface ActiveModalState {
  overlay: HTMLDivElement;
  keyHandler: (event: KeyboardEvent) => void;
  restoreFocus: () => void;
}

let activeModal: ActiveModalState | null = null;

function normaliseConclusion(value?: string | null): 'success' | 'failure' | 'other' {
  if (typeof value !== 'string') {
    return 'other';
  }
  const normalised = value.trim().toLowerCase();
  if (normalised === 'success' || normalised === 'succeeded' || normalised === 'passed') {
    return 'success';
  }
  if (['failure', 'failed', 'cancelled', 'canceled', 'timed_out', 'timed-out', 'action_required', 'stopped'].includes(normalised)) {
    return 'failure';
  }
  return 'other';
}

function formatStatusLabel(value?: string | null): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'Status unknown';
  }
  const trimmed = value.trim();
  return trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
}

function createJobElement(job: GitHubActionJobSummary): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'github-action-job';

  const header = document.createElement('div');
  header.className = 'github-action-job-title';

  const title = document.createElement('span');
  const label = typeof job.name === 'string' && job.name.trim().length > 0
    ? job.name.trim()
    : (job.id !== null ? `Job ${job.id}` : 'Job');
  title.textContent = label;
  header.appendChild(title);

  const statusBadge = document.createElement('span');
  statusBadge.className = 'github-action-job-status';
  const jobConclusion = normaliseConclusion(job.conclusion ?? job.status);
  if (jobConclusion === 'failure') {
    statusBadge.classList.add('failure');
  } else if (jobConclusion === 'success') {
    statusBadge.classList.add('success');
  }
  statusBadge.textContent = formatStatusLabel(job.conclusion ?? job.status);
  header.appendChild(statusBadge);

  wrapper.appendChild(header);

  const failingSteps = Array.isArray(job.steps)
    ? job.steps.filter((step) => normaliseConclusion(step?.conclusion ?? step?.status) === 'failure')
    : [];

  if (failingSteps.length > 0) {
    const list = document.createElement('ul');
    list.className = 'github-action-job-steps';
    failingSteps.forEach((step) => {
      const item = document.createElement('li');
      item.className = 'github-action-job-step';
      const name = typeof step.name === 'string' && step.name.trim().length > 0
        ? step.name.trim()
        : formatStatusLabel(step.conclusion ?? step.status);
      const header = document.createElement('div');
      header.className = 'github-action-job-step-header';

      const heading = document.createElement('span');
      heading.className = 'github-action-job-step-title';
      const descriptionParts: string[] = [];
      const stepNumber = typeof step.number === 'number' && Number.isFinite(step.number)
        ? step.number
        : null;
      if (stepNumber !== null) {
        descriptionParts.push(`Step ${stepNumber}`);
      }
      descriptionParts.push(name);
      heading.textContent = descriptionParts.join(' • ');
      header.appendChild(heading);

      const statusLabel = document.createElement('span');
      statusLabel.className = 'github-action-job-step-status';
      const stepConclusion = normaliseConclusion(step.conclusion ?? step.status);
      if (stepConclusion === 'failure') {
        statusLabel.classList.add('failure');
      } else if (stepConclusion === 'success') {
        statusLabel.classList.add('success');
      }
      statusLabel.textContent = formatStatusLabel(step.conclusion ?? step.status);
      header.appendChild(statusLabel);
      item.appendChild(header);

      const logText = typeof step.log === 'string' ? step.log.trim() : '';
      if (logText.length > 0) {
        item.classList.add('has-log');
        const log = document.createElement('pre');
        log.className = 'github-action-job-step-log';
        log.textContent = logText;
        item.appendChild(log);
      }
      list.appendChild(item);
    });
    wrapper.appendChild(list);
  } else if (jobConclusion === 'failure') {
    const note = document.createElement('p');
    note.className = 'github-action-modal-note';
    note.textContent = 'This job reported a failure, but no step details were provided.';
    wrapper.appendChild(note);
  }

  return wrapper;
}

function closeActiveGitHubActionModal(): void {
  if (!activeModal) {
    return;
  }
  const { overlay, keyHandler, restoreFocus } = activeModal;
  document.removeEventListener('keydown', keyHandler, true);
  overlay.remove();
  requestAnimationFrame(() => {
    restoreFocus();
  });
  activeModal = null;
}

function formatStateLabel(state: string | undefined, fallback: string): string {
  if (typeof state === 'string' && state.trim().length > 0) {
    const trimmed = state.trim();
    return trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1);
  }
  return fallback;
}

export function showGitHubActionModal(pane: PaneState, status: PaneGitHubActionStatus): void {
  if (typeof document === 'undefined' || !document.body) {
    return;
  }

  closeActiveGitHubActionModal();

  const overlay = document.createElement('div');
  overlay.className = 'github-action-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'github-action-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h2');
  const heading = (status.displayTitle ?? status.workflowName ?? '').trim();
  title.textContent = heading.length > 0 ? heading : 'GitHub Actions';
  modal.appendChild(title);

  const subtitleParts: string[] = [];
  const primaryLabel = formatStatusLabel(status.conclusion ?? status.status ?? formatStateLabel(status.state, 'Status unknown'));
  if (primaryLabel) {
    subtitleParts.push(primaryLabel);
  }
  if (typeof status.headBranch === 'string' && status.headBranch.trim().length > 0) {
    subtitleParts.push(`Branch ${status.headBranch.trim()}`);
  }
  if (typeof status.event === 'string' && status.event.trim().length > 0) {
    subtitleParts.push(status.event.trim());
  }
  if (subtitleParts.length > 0) {
    const subtitle = document.createElement('p');
    subtitle.className = 'github-action-modal-subtitle';
    subtitle.textContent = subtitleParts.join(' • ');
    modal.appendChild(subtitle);
  }

  const body = document.createElement('div');
  body.className = 'github-action-modal-body';

  const errorText = typeof status.error === 'string' && status.error.trim().length > 0
    ? status.error.trim()
    : null;

  if (errorText) {
    const error = document.createElement('pre');
    error.className = 'github-action-modal-error';
    error.textContent = errorText;
    body.appendChild(error);
  }

  const jobs = Array.isArray(status.jobs) ? status.jobs : [];
  const failureJobs = jobs.filter((job) => {
    const jobConclusion = normaliseConclusion(job?.conclusion ?? job?.status);
    if (jobConclusion === 'failure') {
      return true;
    }
    return Array.isArray(job?.steps) && job.steps.some((step) => normaliseConclusion(step?.conclusion ?? step?.status) === 'failure');
  });

  if (failureJobs.length > 0) {
    failureJobs.forEach((job) => {
      body.appendChild(createJobElement(job));
    });
  } else {
    const note = document.createElement('p');
    note.className = 'github-action-modal-note';
    if (errorText) {
      note.textContent = 'No run details were available. Review the error above or open GitHub for more information.';
    } else {
      note.textContent = 'No failing job details were provided for this run. Check GitHub for more information.';
    }
    body.appendChild(note);
  }

  modal.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'github-action-modal-footer';

  const trimmedHtmlURL = typeof status.htmlURL === 'string' ? status.htmlURL.trim() : '';
  if (trimmedHtmlURL.length > 0) {
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'github-action-modal-link';
    openButton.textContent = 'Open in GitHub';
    openButton.addEventListener('click', () => {
      if (window.webkit?.messageHandlers?.['previewOpenExternal']) {
        notifyNative('previewOpenExternal', { url: trimmedHtmlURL });
        return;
      }

      if (typeof window.open === 'function') {
        const opened = window.open(trimmedHtmlURL, '_blank', 'noopener,noreferrer');
        if (opened) {
          return;
        }
      }

      window.location.href = trimmedHtmlURL;
    });
    footer.appendChild(openButton);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'github-action-modal-copy';
    copyButton.textContent = 'Copy link';
    copyButton.addEventListener('click', () => {
      copyTextToClipboard(trimmedHtmlURL);
      copyButton.classList.add('copied');
      copyButton.textContent = 'Copied';
      window.setTimeout(() => {
        copyButton.classList.remove('copied');
        copyButton.textContent = 'Copy link';
      }, 1600);
    });
    footer.appendChild(copyButton);
  }

  if (errorText) {
    const copyErrorButton = document.createElement('button');
    copyErrorButton.type = 'button';
    copyErrorButton.className = 'github-action-modal-copy';
    copyErrorButton.textContent = 'Copy error';
    copyErrorButton.addEventListener('click', () => {
      copyTextToClipboard(errorText);
      copyErrorButton.classList.add('copied');
      copyErrorButton.textContent = 'Copied';
      window.setTimeout(() => {
        copyErrorButton.classList.remove('copied');
        copyErrorButton.textContent = 'Copy error';
      }, 1600);
    });
    footer.appendChild(copyErrorButton);
  }

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'github-action-modal-close';
  closeButton.textContent = 'Close';
  closeButton.addEventListener('click', () => closeActiveGitHubActionModal());
  footer.appendChild(closeButton);

  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const restoreFocus = () => {
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
      return;
    }
    const fallback = pane.elements.title;
    if (fallback && document.contains(fallback)) {
      fallback.focus();
    }
  };

  const keyHandler = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeActiveGitHubActionModal();
    }
  };

  document.addEventListener('keydown', keyHandler, true);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closeActiveGitHubActionModal();
    }
  });

  requestAnimationFrame(() => {
    closeButton.focus();
  });

  activeModal = {
    overlay,
    keyHandler,
    restoreFocus,
  };
}

export function showGitHubActionFailureModal(pane: PaneState, status: PaneGitHubActionStatus): void {
  showGitHubActionModal(pane, status);
}
