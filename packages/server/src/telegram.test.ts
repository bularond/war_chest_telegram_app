/**
 * Checking a Telegram launch.
 *
 * Every rejection looks the same to the player — the app asks to sign in
 * again — so what is under test here is mostly that the server can tell them
 * apart and say which one happened.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { botIdOf, verifyInitData } from './telegram.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const OTHER = '987654321:BBFbqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** Signs launch parameters the way Telegram does. */
function launch(token: string, params: Record<string, string>): string {
  const check = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

const user = JSON.stringify({ id: 4242, first_name: 'Артём', last_name: 'Кузнецов' });
const now = () => String(Math.floor(Date.now() / 1000));

describe('verifyInitData', () => {
  it('accepts a launch this bot signed', () => {
    const result = verifyInitData(launch(TOKEN, { user, auth_date: now() }), TOKEN);
    expect(result).toEqual({
      ok: true,
      user: { id: '4242', firstName: 'Артём', lastName: 'Кузнецов' },
    });
  });

  it('ignores the Ed25519 signature Telegram sends alongside', () => {
    // Newer clients add `signature`, which is not part of the HMAC. Counting
    // it in would turn every launch from an up-to-date Telegram into a bad
    // signature — and only for some users, which is the worst kind of bug.
    const signed = launch(TOKEN, { user, auth_date: now() });
    const withSignature = `${signed}&signature=abc123`;
    expect(verifyInitData(withSignature, TOKEN).ok).toBe(true);
  });

  it('names the reason it turned a launch away', () => {
    const reason = (initData: string) => {
      const r = verifyInitData(initData, TOKEN);
      return r.ok ? 'accepted' : r.reason;
    };

    // Not running inside Telegram at all.
    expect(reason('')).toBe('no-init-data');
    // Parameters, but nothing signing them.
    expect(reason(new URLSearchParams({ user, auth_date: now() }).toString())).toBe('no-hash');
    // The mistake that costs an evening: the app is opened from one bot and
    // the server holds another one's token.
    expect(reason(launch(OTHER, { user, auth_date: now() }))).toBe('bad-signature');
    // A Mini App left open since yesterday, or a clock that is far off.
    const old = String(Math.floor(Date.now() / 1000) - 25 * 60 * 60);
    expect(reason(launch(TOKEN, { user, auth_date: old }))).toBe('expired');
    // Signed, current, and about nobody.
    expect(reason(launch(TOKEN, { auth_date: now() }))).toBe('no-user');
  });
});

describe('botIdOf', () => {
  it('takes the public half of the token, and nothing more', () => {
    expect(botIdOf(TOKEN)).toBe('123456789');
    expect(botIdOf('nonsense')).toBe('nonsense');
  });
});
