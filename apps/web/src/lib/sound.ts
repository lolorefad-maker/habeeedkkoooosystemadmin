import { create } from 'zustand';

/**
 * Alert sounds synthesized with Web Audio: no audio files, works offline, allowed by the CSP.
 * Browsers only allow sound after a user gesture, so the context is unlocked on the first tap
 * (logging in with the PIN pad does it) — until then the header bell shows "tap to enable".
 */

type AudioState = 'locked' | 'ready' | 'unsupported';
export const useAudio = create<{ state: AudioState; set: (s: AudioState) => void }>((set) => ({
  state: typeof window !== 'undefined' && 'AudioContext' in window ? 'locked' : 'unsupported',
  set: (state) => set({ state }),
}));

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (useAudio.getState().state === 'unsupported') return null;
  ctx ??= new AudioContext();
  return ctx;
}

/** Call from a user gesture. Safe to call repeatedly. */
export async function unlockAudio(): Promise<boolean> {
  const c = context();
  if (!c) return false;
  try {
    if (c.state !== 'running') await c.resume();
  } catch {
    /* still locked */
  }
  const ok = c.state === 'running';
  useAudio.getState().set(ok ? 'ready' : 'locked');
  return ok;
}

/** Unlock on the first pointer/key interaction anywhere in the app. */
export function installAudioUnlock() {
  const handler = () => {
    void unlockAudio().then((ok) => {
      if (ok) {
        window.removeEventListener('pointerdown', handler);
        window.removeEventListener('keydown', handler);
      }
    });
  };
  window.addEventListener('pointerdown', handler);
  window.addEventListener('keydown', handler);
  return () => {
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
  };
}

function tone(c: AudioContext, freq: number, start: number, duration: number, volume: number, type: OscillatorType) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  // Short attack/release: no clicks, pleasant even when repeated.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** Soft two-note chime: "a few minutes left". */
export function playChime() {
  const c = context();
  if (!c || c.state !== 'running') return false;
  const t = c.currentTime + 0.02;
  tone(c, 880, t, 0.22, 0.18, 'sine');
  tone(c, 1318.5, t + 0.2, 0.35, 0.16, 'sine');
  return true;
}

/** Clear alarm: two bursts of three beeps — "time is up". */
export function playAlarm() {
  const c = context();
  if (!c || c.state !== 'running') return false;
  let t = c.currentTime + 0.02;
  for (let burst = 0; burst < 2; burst++) {
    for (let i = 0; i < 3; i++) {
      tone(c, 988, t, 0.16, 0.22, 'triangle');
      t += 0.24;
    }
    t += 0.35;
  }
  return true;
}
