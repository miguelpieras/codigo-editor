import { postLog } from './nativeBridge.js';

export function whenTerminalReady(callback: () => void, attempt = 0): void {
  if (typeof window.Terminal === 'function') {
    callback();
    return;
  }

  if (attempt > 100) {
    postLog({ type: 'terminal-timeout' });
    return;
  }

  window.setTimeout(() => whenTerminalReady(callback, attempt + 1), 50);
}
