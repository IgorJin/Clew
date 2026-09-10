import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export const COMMAND_HOLD_THRESHOLD_MS = 180;

const MODIFIER_KEYS = new Set(['Meta', 'Shift', 'Control', 'Alt', 'AltGraph']);

export function useCommandHold(threshold = COMMAND_HOLD_THRESHOLD_MS) {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    activeRef.current = false;
    setActive(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') {
        if (event.repeat || timerRef.current !== undefined || activeRef.current) return;
        timerRef.current = window.setTimeout(() => {
          timerRef.current = undefined;
          activeRef.current = true;
          setActive(true);
        }, threshold);
        return;
      }
      // Pure modifier presses must not dismiss the overlay: chords like
      // Cmd, then Shift, then a key are pressed as a progressive sequence.
      if (MODIFIER_KEYS.has(event.key)) return;
      if (event.metaKey || activeRef.current) clear();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') clear();
    };
    const onBlur = () => clear();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      clear();
    };
  }, [clear, threshold]);

  return { active, reset: clear };
}
