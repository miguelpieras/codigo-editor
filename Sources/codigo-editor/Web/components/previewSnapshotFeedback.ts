export interface SnapshotFeedbackButton {
  title: string;
  dataset: Record<string, string | undefined>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

type ScheduleFn = (callback: () => void, delay: number) => number;
type CancelFn = (id: number) => void;
export type SnapshotFeedbackState = 'idle' | 'success' | 'error';

export interface SnapshotFeedbackOptions {
  button: SnapshotFeedbackButton;
  defaultTitle: string;
  defaultLabel: string;
  resetDelay: number;
  schedule?: ScheduleFn;
  cancel?: CancelFn;
  onStateChange?: (state: SnapshotFeedbackState, message: string) => void;
}

export class SnapshotFeedbackController {
  private timer: number | null = null;
  private readonly button: SnapshotFeedbackButton;
  private readonly defaultTitle: string;
  private readonly defaultLabel: string;
  private readonly resetDelay: number;
  private readonly schedule: ScheduleFn;
  private readonly cancel: CancelFn;
  private readonly onStateChange: ((state: SnapshotFeedbackState, message: string) => void) | null;

  constructor(options: SnapshotFeedbackOptions) {
    this.button = options.button;
    this.defaultTitle = options.defaultTitle;
    this.defaultLabel = options.defaultLabel;
    this.resetDelay = options.resetDelay;
    this.schedule = options.schedule ?? ((callback, delay) => window.setTimeout(callback, delay));
    this.cancel = options.cancel ?? ((id) => window.clearTimeout(id));
    this.onStateChange = options.onStateChange ?? null;
    this.toIdle();
  }

  toIdle(): void {
    this.button.title = this.defaultTitle;
    this.button.setAttribute('aria-label', this.defaultLabel);
    this.button.dataset['feedbackState'] = 'idle';
    this.emitStateChange('idle', this.defaultTitle);
  }

  show(success: boolean, message: string): void {
    this.clearTimer();
    this.button.title = message;
    this.button.setAttribute('aria-label', message);
    this.button.dataset['feedbackState'] = success ? 'success' : 'error';
    this.emitStateChange(success ? 'success' : 'error', message);
    this.timer = this.schedule(() => {
      this.timer = null;
      this.toIdle();
    }, this.resetDelay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private emitStateChange(state: SnapshotFeedbackState, message: string): void {
    if (this.onStateChange) {
      this.onStateChange(state, message);
    }
  }
}

export function normaliseSnapshotResult(payload: unknown): boolean {
  if (typeof payload === 'boolean') {
    return payload;
  }
  if (typeof payload === 'string') {
    const normalised = payload.trim().toLowerCase();
    if (normalised === 'true') {
      return true;
    }
    if (normalised === 'false') {
      return false;
    }
    if (normalised.length === 0) {
      return false;
    }
  }
  if (typeof payload === 'number') {
    return Number.isFinite(payload) && payload !== 0;
  }
  if (payload === null || payload === undefined) {
    return false;
  }
  return true;
}
