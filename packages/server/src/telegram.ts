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

/**
 * Why a launch was turned away. All of these look the same from the outside —
 * the app asks you to sign in again and again — and they are fixed in
 * completely different places, so the server has to be able to say which one
 * it was without anyone attaching a debugger to a phone.
 */
export type AuthFailure =
  /** Nothing was signed: the page is not running inside Telegram at all. */
  | 'no-init-data'
  /** Launch parameters without a signature. */
  | 'no-hash'
  /** Signed by a different bot than TELEGRAM_BOT_TOKEN belongs to. */
  | 'bad-signature'
  /** Older than a day: a Mini App left open, or a clock that is far off. */
  | 'expired'
  /** Signature checks out, but Telegram named no user. */
  | 'no-user';

export type AuthResult =
  /** `signedOver` says which of the two check strings matched. */
  | { ok: true; user: TelegramUser; signedOver: 'all-fields' | 'without-signature' }
  | { ok: false; reason: AuthFailure };

/** Every field but `hash`, `key=value`, sorted by key, one per line. */
function checkString(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function verifyInitData(initData: string, botToken: string): AuthResult {
  if (!initData) return { ok: false, reason: 'no-init-data' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no-hash' };
  params.delete('hash');

  /*
   * Telegram hashes "all received fields except hash". Current clients also
   * send `signature`, the Ed25519 one meant for validating without the bot
   * token — and *that* check is the one that leaves it out. Dropping it from
   * the HMAC too, as this did, turns every launch from an up-to-date Telegram
   * into a bad signature.
   *
   * Both strings are tried rather than one, because each is an HMAC under the
   * bot token: neither can be produced without it, so accepting either costs
   * nothing and covers clients on both sides of the change.
   */
  const withSignature = checkString(params);
  const withoutSignature = new URLSearchParams(params);
  withoutSignature.delete('signature');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const given = Buffer.from(hash, 'hex');
  const matches = (data: string): boolean => {
    const expected = Buffer.from(createHmac('sha256', secret).update(data).digest('hex'), 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  const signedOver = matches(withSignature)
    ? 'all-fields'
    : matches(checkString(withoutSignature))
      ? 'without-signature'
      : null;
  if (!signedOver) return { ok: false, reason: 'bad-signature' };

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    return { ok: false, reason: 'expired' };
  }

  const user = parseUser(params.get('user'));
  return user ? { ok: true, user, signedOver } : { ok: false, reason: 'no-user' };
}

/**
 * The bot a token belongs to — the number in front of the colon, which is
 * public. Logged at startup so "the app will not let me in" can be answered by
 * comparing one number with BotFather instead of by guessing.
 */
export function botIdOf(token: string): string {
  return token.split(':')[0] ?? '?';
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
