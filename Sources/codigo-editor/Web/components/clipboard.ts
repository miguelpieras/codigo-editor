import { notifyNative } from './nativeBridge.js';

export function copyTextToClipboard(text: string): void {
  if (typeof text !== 'string') {
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  notifyNative('copy', { text: trimmed });

  try {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(trimmed).catch(() => {
        /* Falling back to native handler */
      });
    }
  } catch (error) {
    console.warn('clipboard.writeText failed', error);
  }
}
