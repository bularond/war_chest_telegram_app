/**
 * The chat half on its own, for `ROLE=chat`.
 *
 * A process that does one thing: hold a long poll open against
 * `api.telegram.org` and answer every message with the button into the Mini
 * App. It serves nothing, stores nothing and never sees a game — which is what
 * makes it deployable somewhere the app itself has no business being.
 *
 * The players never reach this process, so it needs no port; the Mini App it
 * points at is named by `PUBLIC_URL` and may be on the other side of the world.
 */

import type { Config } from './config.js';
import { startChat, type ChatLog } from './telegram-chat.js';
import { botIdOf } from './telegram.js';

/** Fastify brings a logger with it, and this role has no Fastify. */
const log: ChatLog = {
  info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
};

export async function runChat(config: Config): Promise<void> {
  // Guaranteed by loadConfig, which refuses to build a chat role without them.
  const token = config.botToken!;
  const appUrl = config.publicUrl!;

  const chat = startChat({ token, appUrl, log });
  log.info({ bot: botIdOf(token), appUrl }, 'Telegram chat is answering');

  /*
   * Docker sends SIGTERM and waits ten seconds. Stopping the poll rather than
   * dying under it matters here: Telegram keeps handing out the same updates
   * until they are acknowledged, so a poller killed mid-batch makes the next
   * one greet somebody twice.
   */
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'Telegram chat is stopping');
      chat.stop();
    });
  }

  await chat.done;
}
