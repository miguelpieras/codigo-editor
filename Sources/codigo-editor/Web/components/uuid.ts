const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  let timestamp = Date.now();
  let microTick = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? Math.floor(performance.now() * 1000)
    : 0;

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    let random = Math.random() * 16;

    if (timestamp > 0) {
      random = (timestamp + random) % 16;
      timestamp = Math.floor(timestamp / 16);
    } else {
      random = (microTick + random) % 16;
      microTick = Math.floor(microTick / 16);
    }

    const value = Math.floor(random);
    if (char === 'y') {
      return ((value & 0x3) | 0x8).toString(16);
    }
    return value.toString(16);
  });
}

export function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
