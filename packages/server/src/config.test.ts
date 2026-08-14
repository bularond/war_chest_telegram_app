/** Which half of the program a process is, and what it refuses to start without. */

import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const TOKEN = '123456:AAEyEwEyEwEyEwEyEwEyEwEyEwEyEwEyEwE';
const APP = 'https://warchestapp.example.com';

describe('ROLE', () => {
  it('is both when nothing says otherwise, which is the old behaviour', () => {
    expect(loadConfig({}).role).toBe('both');
  });

  it('reads app, chat and both', () => {
    expect(loadConfig({ ROLE: 'app' }).role).toBe('app');
    expect(loadConfig({ ROLE: 'chat', TELEGRAM_BOT_TOKEN: TOKEN, PUBLIC_URL: APP }).role).toBe(
      'chat',
    );
    expect(loadConfig({ ROLE: 'both' }).role).toBe('both');
  });

  it('forgives the shape a value picks up in a shell', () => {
    expect(loadConfig({ ROLE: ' App ' }).role).toBe('app');
  });

  it('refuses a role it does not have, rather than guessing at one', () => {
    // A typo here silently deciding "both" is how one token ends up with two
    // pollers, and that failure shows up as missing greetings, not as an error.
    expect(() => loadConfig({ ROLE: 'bot' })).toThrow(/ROLE must be one of/);
  });
});

describe('ROLE=chat', () => {
  it('needs a token to poll with', () => {
    expect(() => loadConfig({ ROLE: 'chat', PUBLIC_URL: APP })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('needs an address to put on the button', () => {
    expect(() => loadConfig({ ROLE: 'chat', TELEGRAM_BOT_TOKEN: TOKEN })).toThrow(/PUBLIC_URL/);
  });

  it('starts once it has both', () => {
    const config = loadConfig({ ROLE: 'chat', TELEGRAM_BOT_TOKEN: TOKEN, PUBLIC_URL: APP });
    expect(config.botToken).toBe(TOKEN);
    expect(config.publicUrl).toBe(APP);
  });
});

describe('the rest of it', () => {
  it('still demands a token in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('lets the app role run without a public address', () => {
    // The app half never talks to Telegram, so it has no use for one.
    expect(loadConfig({ ROLE: 'app', TELEGRAM_BOT_TOKEN: TOKEN }).publicUrl).toBe(null);
  });

  it('trims the trailing slash a copied address arrives with', () => {
    expect(loadConfig({ PUBLIC_URL: `${APP}//` }).publicUrl).toBe(APP);
  });
});
