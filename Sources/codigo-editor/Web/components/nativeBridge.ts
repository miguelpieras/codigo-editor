export function postLog(message: unknown): void {
  window.webkit?.messageHandlers?.['log']?.postMessage(message);
}

export function notifyNative(handler: string, payload: unknown): void {
  const target = window.webkit?.messageHandlers?.[handler];
  target?.postMessage(payload);
}

export function notifyNativeReady(): void {
  notifyNative('ready', {});
}
