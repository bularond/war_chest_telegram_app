/** The bot's replies in chat, and the loop that delivers them. */

import { describe, expect, it, vi } from 'vitest';
import { replyTo, startChat, type TelegramUpdate } from './telegram-chat.js';

const APP = 'https://warchestapp.example.com';

function message(text: string, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      chat: { id: 777, type: 'private' },
      from: { first_name: 'Артём' },
      text,
      ...extra,
    },
  };
}

describe('replyTo', () => {
  it('greets by name on /start, with the app on a button', () => {
    const reply = replyTo(message('/start'), APP)!;
    expect(reply.chat_id).toBe(777);
    expect(reply.text).toContain('Артём');
    expect(reply.text).toContain('Сундук войны');
    expect(reply.reply_markup.inline_keyboard[0]![0]!.web_app.url).toBe(APP);
  });

  it('answers anything else with the same button', () => {
    // The whole game is inside the Mini App, so there is no other answer to
    // give — but there must be one, or the bot looks broken.
    const reply = replyTo(message('привет'), APP)!;
    expect(reply.text).not.toContain('Артём');
    expect(reply.reply_markup.inline_keyboard[0]![0]!.web_app.url).toBe(APP);
  });

  it('has no name to use, and still says something', () => {
    const reply = replyTo(message('/start', { from: {} }), APP)!;
    expect(reply.text.startsWith('Воевода')).toBe(true);
  });

  it('keeps out of groups, channels and other bots', () => {
    expect(replyTo(message('/start', { chat: { id: 5, type: 'group' } }), APP)).toBeNull();
    expect(replyTo(message('/start', { from: { is_bot: true } }), APP)).toBeNull();
    expect(replyTo({ update_id: 2 }, APP)).toBeNull();
  });
});

describe('the polling loop', () => {
  const log = { info: () => {}, warn: () => {} };

  it('answers an update and asks for the next one after it', async () => {
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const call = vi.fn(async (_token: string, method: string, payload: object) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method !== 'getUpdates') return {} as never;
      // One update, then nothing: the second poll ends the test.
      if (calls.filter((c) => c.method === 'getUpdates').length === 1) {
        return [{ ...message('/start'), update_id: 42 }] as never;
      }
      chat.stop();
      return [] as never;
    });

    const chat = startChat({ token: 't', appUrl: APP, log, pollSeconds: 0, call });
    await chat.done;

    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.chat_id).toBe(777);
    // Offset moves past what was handled, or Telegram hands it back forever.
    expect(calls.filter((c) => c.method === 'getUpdates')[1]!.payload.offset).toBe(43);
  });

  it('waits and carries on when the API is unhappy', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const call = vi.fn(async (_t: string, method: string) => {
      if (method !== 'getUpdates') return {} as never;
      polls += 1;
      // 409 is the other copy of the server holding the same token. It is not
      // fixed by retrying at full speed.
      if (polls === 1) throw new Error('getUpdates: Conflict');
      chat.stop();
      return [] as never;
    });

    const warned: object[] = [];
    const chat = startChat({
      token: 't',
      appUrl: APP,
      log: { info: () => {}, warn: (o) => warned.push(o) },
      pollSeconds: 0,
      call,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await chat.done;
    vi.useRealTimers();

    expect(warned).toHaveLength(1);
    expect(polls).toBe(2);
  });
});
