/**
 * The part of the screen the user can actually see, as CSS variables, so windows and sheets sit
 * above a phone's on-screen keyboard instead of under it:
 * - `--vv-top` / `--vv-height`: the visible area,
 * - `--vv-bottom`: how much of the page the keyboard covers (0 when it is closed).
 * iPhone puts the keyboard over the page and Android does too by default; neither moves fixed
 * elements, so without this a form shows only its first field above the keyboard.
 */
export function installViewportVars(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  let frame = 0;

  const apply = () => {
    frame = 0;
    // Pinch-zoomed in: the visible area is not about the keyboard — keep the full layout.
    const zoomed = vv.scale > 1.01;
    const height = zoomed ? window.innerHeight : vv.height;
    const top = zoomed ? 0 : vv.offsetTop;
    root.style.setProperty('--vv-height', `${Math.round(height)}px`);
    root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    root.style.setProperty('--vv-bottom', `${Math.max(0, Math.round(window.innerHeight - height - top))}px`);

    // The window just got shorter around the field being typed in: keep that field in sight.
    const el = document.activeElement as HTMLElement | null;
    if (el && el.closest('[role="dialog"]') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };

  apply();
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
  };
}

/** A phone or tablet without a mouse: focusing a field there opens the on-screen keyboard. */
export const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/**
 * `autoFocus` for a field in a window: yes with a mouse and keyboard; no on a touch screen, where it
 * would throw the keyboard over the window before the user has seen it — they tap the field instead.
 */
export const autoFocusField = () => !isTouchDevice();
