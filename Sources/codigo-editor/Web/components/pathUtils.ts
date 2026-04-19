export function normaliseDirectoryKey(input: unknown): string {
  if (typeof input !== 'string') {
    return '';
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === '/' || trimmed === '\\') {
    return '/';
  }

  const stripped = trimmed.replace(/[\\/]+$/u, '');
  if (!stripped) {
    return '/';
  }

  if (/^[A-Za-z]:$/u.test(stripped)) {
    return `${stripped}\\`;
  }

  return stripped;
}

export function sanitizeCommandList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const commands: string[] = [];
  values.forEach((value) => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    commands.push(trimmed);
  });
  return commands;
}

export function sanitizeLinkList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<string>();
  const links: string[] = [];
  values.forEach((value) => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    links.push(trimmed);
  });
  return links;
}
