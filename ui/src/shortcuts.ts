import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';

export type ShortcutScope = 'modal' | 'terminal' | 'input' | 'task' | 'global';

export type KeyCombo = {
  key?: string;
  code?: string;
  primary?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export type Shortcut = {
  id: string;
  label: string;
  chord: string;
  hint?: string;
  fallbackChords?: string[];
  combos: KeyCombo[];
  scopes: ShortcutScope[];
  enabled?: () => boolean;
  disabledReason?: () => string | undefined;
  onDisabled?: (reason: string) => void;
  run: (event: KeyboardEvent) => void;
};

export type ShortcutResolution = {
  shortcut: Shortcut | null;
  disabled?: Shortcut;
  reason?: string;
};

export type ShortcutMetadata = {
  id: string;
  label: string;
  chord: string;
  hint: string;
  fallbackChords: string[];
  scopes: ShortcutScope[];
  enabled: boolean;
  disabledReason?: string;
};

export function comboMatches(combo: KeyCombo, event: KeyboardEvent): boolean {
  const primary = event.metaKey || event.ctrlKey;

  if (Boolean(combo.primary) !== primary) return false;
  if (Boolean(combo.alt) !== event.altKey) return false;
  if (Boolean(combo.shift) !== event.shiftKey) return false;
  if (combo.code) return event.code === combo.code;
  if (combo.key) return event.key.toLowerCase() === combo.key.toLowerCase();

  return false;
}

export function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;

  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;

  const editable = element.getAttribute('contenteditable');

  return editable !== null && editable !== 'false';
}

export function isTerminalElement(element: Element | null): boolean {
  return Boolean(element?.closest('.xterm'));
}

export function resolveShortcut(
  event: KeyboardEvent,
  shortcuts: Shortcut[],
  scope: ShortcutScope,
): ShortcutResolution {
  for (const shortcut of shortcuts) {
    if (!shortcut.scopes.includes(scope)) continue;
    if (!shortcut.combos.some((combo) => comboMatches(combo, event))) continue;
    if (shortcut.enabled && !shortcut.enabled())
      return { shortcut: null, disabled: shortcut, reason: shortcut.disabledReason?.() };

    return { shortcut };
  }

  return { shortcut: null };
}

const registry = new Map<string, Shortcut>();

export function listShortcuts(scope?: ShortcutScope): ShortcutMetadata[] {
  return [...registry.values()]
    .filter((shortcut) => !scope || shortcut.scopes.includes(scope))
    .map((shortcut) => ({
      id: shortcut.id,
      label: shortcut.label,
      chord: shortcut.chord,
      hint: shortcut.hint ?? shortcut.chord,
      fallbackChords: shortcut.fallbackChords ?? [],
      scopes: [...shortcut.scopes],
      enabled: shortcut.enabled ? shortcut.enabled() : true,
      disabledReason: shortcut.disabledReason?.(),
    }));
}

export function useShortcuts(shortcuts: Shortcut[], scope: () => ShortcutScope): void {
  const shortcutsRef = useRef(shortcuts);

  shortcutsRef.current = shortcuts;
  const scopeRef = useRef(scope);

  scopeRef.current = scope;

  useLayoutEffect(() => {
    for (const shortcut of shortcuts) registry.set(shortcut.id, shortcut);

    return () => {
      for (const shortcut of shortcuts)
        if (registry.get(shortcut.id) === shortcut) registry.delete(shortcut.id);
    };
  }, [shortcuts]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.repeat) return;

      const { shortcut, disabled, reason } = resolveShortcut(
        event,
        shortcutsRef.current,
        scopeRef.current(),
      );

      if (shortcut) {
        event.preventDefault();
        shortcut.run(event);
        return;
      }
      if (disabled?.onDisabled) {
        event.preventDefault();
        disabled.onDisabled(reason ?? '');
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
