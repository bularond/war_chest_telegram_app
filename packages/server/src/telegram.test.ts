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

/** Signs launch parameters the way Telegram does: every field, sorted by key. */
function launch(token: string, params: Record<string, string>): string {
  const check = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
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
      signedOver: 'all-fields',
    });
  });

  it('counts the Ed25519 signature field into the HMAC, as Telegram does', () => {
    // Current clients send `signature` beside `hash`. Telegram hashes every
    // field it sends except `hash`, so this one is in the check string —
    // leaving it out rejected every launch from an up-to-date Telegram, which
    // is exactly how this was found: in production, with a correct token.
    const signed = launch(TOKEN, { user, auth_date: now(), signature: 'AbCd_ed25519' });
    const result = verifyInitData(signed, TOKEN);
    expect(result.ok && result.signedOver).toBe('all-fields');
  });

  it('still takes a launch hashed without it, for clients from before', () => {
    const params = { user, auth_date: now() };
    const older = `${launch(TOKEN, params)}&signature=AbCd_ed25519`;
    const result = verifyInitData(older, TOKEN);
    expect(result.ok && result.signedOver).toBe('without-signature');
  });

  it('takes neither from the wrong token', () => {
    const withField = launch(OTHER, { user, auth_date: now(), signature: 'x' });
    const withoutField = `${launch(OTHER, { user, auth_date: now() })}&signature=x`;
    for (const initData of [withField, withoutField]) {
      const result = verifyInitData(initData, TOKEN);
      expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    }
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
