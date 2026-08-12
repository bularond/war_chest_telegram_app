/**
 * Validating Telegram Mini App `initData`.
 *
 * Telegram signs the launch parameters with a key derived from the bot token.
 * Any request that fails this check is anonymous and must not be trusted.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  readonly id: string;
  readonly firstName: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly photoUrl?: string;
  readonly languageCode?: string;
}

/** How old a launch may be before we reject it. */
const MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyInitData(initData: string, botToken: string): TelegramUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  params.delete('signature'); // Ed25519 third-party signature, not part of the HMAC

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return null;

  return parseUser(params.get('user'));
}

export function parseUser(raw: string | null): TelegramUser | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as Record<string, unknown>;
    if (typeof u.id !== 'number' && typeof u.id !== 'string') return null;
    return {
      id: String(u.id),
      firstName: typeof u.first_name === 'string' ? u.first_name : 'Player',
      ...(typeof u.last_name === 'string' ? { lastName: u.last_name } : {}),
      ...(typeof u.username === 'string' ? { username: u.username } : {}),
      ...(typeof u.photo_url === 'string' ? { photoUrl: u.photo_url } : {}),
      ...(typeof u.language_code === 'string' ? { languageCode: u.language_code } : {}),
    };
  } catch {
    return null;
  }
}

export function displayName(user: TelegramUser): string {
  return user.lastName ? `${user.firstName} ${user.lastName[0]}.` : user.firstName;
}
