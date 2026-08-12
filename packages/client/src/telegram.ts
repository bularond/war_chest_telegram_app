/** Thin wrapper over the Telegram Mini App SDK, safe to use outside Telegram. */

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string; last_name?: string } };
  ready(): void;
  expand(): void;
  requestFullscreen?(): void;
  lockOrientation?(orientation: 'portrait' | 'landscape'): void;
  unlockOrientation?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const webApp = (): TelegramWebApp | undefined => window.Telegram?.WebApp;

export const inTelegram = (): boolean => Boolean(webApp()?.initData);

export function initTelegram(): void {
  const app = webApp();
  if (!app) return;
  app.ready();
  app.expand();
  app.setHeaderColor?.('#f5ead8');
  app.setBackgroundColor?.('#f5ead8');
}

export function initData(): string {
  return webApp()?.initData ?? '';
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  webApp()?.HapticFeedback?.impactOccurred(style);
}

export function notify(type: 'error' | 'success' | 'warning'): void {
  webApp()?.HapticFeedback?.notificationOccurred(type);
}

/**
 * The two armies face each other across the board's short axis, so the board is
 * taller than it is wide and the game screen asks to be held upright.
 */
export function lockPortrait(on: boolean): void {
  const app = webApp();
  if (!app) return;
  if (on) app.lockOrientation?.('portrait');
  else app.unlockOrientation?.();
}

/**
 * Outside Telegram there is no signed identity. Keep a stable per-browser one so
 * reloading during development does not lose your seat.
 */
export function devIdentity(): { userId: string; displayName: string } {
  const KEY = 'wc.devUser';
  const stored = localStorage.getItem(KEY);
  if (stored) return JSON.parse(stored) as { userId: string; displayName: string };
  const user = {
    userId: `dev-${Math.random().toString(36).slice(2, 8)}`,
    displayName: `Гость ${Math.floor(Math.random() * 90 + 10)}`,
  };
  localStorage.setItem(KEY, JSON.stringify(user));
  return user;
}
