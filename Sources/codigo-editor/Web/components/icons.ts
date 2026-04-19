import {
  mdiClose,
  mdiChevronDown,
  mdiPlus,
  mdiArrowLeftBold,
  mdiArrowRightBold,
  mdiRefresh,
  mdiArrowExpand,
  mdiRobotHappyOutline,
  mdiConsole,
  mdiMonitor,
  mdiUndoVariant,
  mdiCodeTags,
  mdiFolderOpenOutline,
  mdiCloudUploadOutline,
  mdiOpenInNew,
  mdiPlay,
  mdiCamera,
  mdiCheck,
} from '@mdi/js';

const ICON_PATHS: Record<string, string> = {
  close: mdiClose,
  chevronDown: mdiChevronDown,
  plus: mdiPlus,
  arrowBack: mdiArrowLeftBold,
  arrowForward: mdiArrowRightBold,
  refresh: mdiRefresh,
  maximize: mdiArrowExpand,
  columnPrimary: mdiRobotHappyOutline,
  columnStacked: mdiConsole,
  columnPreview: mdiMonitor,
  undo: mdiUndoVariant,
  gitPush: mdiCloudUploadOutline,
  openInCursor: mdiCodeTags,
  openInFinder: mdiFolderOpenOutline,
  openInNew: mdiOpenInNew,
  play: mdiPlay,
  camera: mdiCamera,
  check: mdiCheck,
};

export function createIcon(name: keyof typeof ICON_PATHS): SVGSVGElement | null {
  const pathData = ICON_PATHS[name];
  if (!pathData) {
    return null;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', pathData);
  svg.appendChild(path);

  return svg;
}
