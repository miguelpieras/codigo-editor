export interface ContextMenuItem {
  label: string;
  action: () => void;
}

let activeMenu: HTMLDivElement | null = null;
let cleanupCallbacks: (() => void)[] = [];

function cleanup(): void {
  cleanupCallbacks.forEach((teardown) => {
    try {
      teardown();
    } catch (error) {
      console.warn('Failed to remove context menu listener', error);
    }
  });
  cleanupCallbacks = [];

  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

function handleOutsideInteraction(event: Event): void {
  if (!activeMenu) {
    return;
  }
  const target = event.target as Node | null;
  if (target && activeMenu.contains(target)) {
    return;
  }
  cleanup();
}

function handleKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    cleanup();
  }
}

export function dismissContextMenu(): void {
  cleanup();
}

export function showContextMenu(event: MouseEvent, items: ContextMenuItem[]): void {
  event.preventDefault();
  event.stopPropagation();

  cleanup();

  if (!items.length || !document?.body) {
    return;
  }

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-menu-item';
    button.textContent = item.label;
    button.addEventListener('click', (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      cleanup();
      try {
        item.action();
      } catch (error) {
        console.error('Context menu action failed', error);
      }
    });
    menu.appendChild(button);
  });

  menu.addEventListener('contextmenu', (contextEvent) => {
    contextEvent.preventDefault();
  });

  document.body.appendChild(menu);
  activeMenu = menu;

  const { clientX, clientY } = event;
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;

  if (left + rect.width > innerWidth) {
    left = Math.max(0, innerWidth - rect.width - 8);
  }
  if (top + rect.height > innerHeight) {
    top = Math.max(0, innerHeight - rect.height - 8);
  }

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const clickHandler = (e: MouseEvent) => handleOutsideInteraction(e);
  const contextHandler = (e: MouseEvent) => handleOutsideInteraction(e);
  const keyHandler = (e: KeyboardEvent) => handleKey(e);
  const blurHandler = () => cleanup();
  const resizeHandler = () => cleanup();

  document.addEventListener('click', clickHandler, true);
  document.addEventListener('contextmenu', contextHandler, true);
  document.addEventListener('keydown', keyHandler, true);
  window.addEventListener('blur', blurHandler);
  window.addEventListener('resize', resizeHandler);

  cleanupCallbacks = [
    () => document.removeEventListener('click', clickHandler, true),
    () => document.removeEventListener('contextmenu', contextHandler, true),
    () => document.removeEventListener('keydown', keyHandler, true),
    () => window.removeEventListener('blur', blurHandler),
    () => window.removeEventListener('resize', resizeHandler),
  ];
}
