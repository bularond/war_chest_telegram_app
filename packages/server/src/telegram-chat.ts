/**
 * The bot's side of the conversation.
 *
 * Everything the game does happens inside the Mini App, so the chat has one
 * job: hand the player a button that opens it. Whatever they type — /start,
 * "привет", a photo of a cat — the answer is the same greeting with the same
 * button, because there is nothing else the bot knows how to do.
 *
 * Long polling rather than a webhook: it needs no public URL to register, no
 * secret to check, and it works the same on a laptop as on the server. The one
 * thing to know is that Telegram allows a single poller per token — a second
 * instance gets 409 Conflict, which is logged plainly rather than retried into
 * the ground.
 *
 * `bot` here means the Telegram bot. The computer opponent, confusingly also a
 * bot, lives in bot-runner.ts and has nothing to do with any of this.
 */

/** Only the parts of an update this bot looks at. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly chat?: { readonly id?: number; readonly type?: string };
    readonly from?: { readonly first_name?: string; readonly is_bot?: boolean };
    readonly text?: string;
  };
}

export interface SendMessage {
  readonly chat_id: number;
  readonly text: string;
  readonly reply_markup: {
    readonly inline_keyboard: readonly (readonly {
      readonly text: string;
      readonly web_app: { readonly url: string };
    }[])[];
  };
}

const GREETING = (name: string) =>
  `${name}, добро пожаловать в «Сундук войны» — дуэль по правилам настольной War Chest.\n\n` +
  'Драфт отрядов, мешок монет, гекс-поле. Побеждает тот, кто первым выставит ' +
  'все свои контрольные маркеры.\n\n' +
  'Можно сыграть с живым соперником по коду стола или сразу против компьютера.';

const ANYTHING_ELSE =
  'Разговаривать я не умею — вся игра внутри приложения. Открывайте кнопкой ниже.';

/**
 * What to answer with, or nothing at all. Groups, channels and other bots are
 * left alone: this bot is only useful one-to-one.
 */
export function replyTo(update: TelegramUpdate, appUrl: string): SendMessage | null {
  const message = update.message;
  const chatId = message?.chat?.id;
  if (!message || chatId === undefined) return null;
  if (message.chat?.type !== 'private') return null;
  if (message.from?.is_bot) return null;

  const start = (message.text ?? '').startsWith('/start');
  const name = message.from?.first_name?.trim() || 'Воевода';
  return {
    chat_id: chatId,
    text: start ? GREETING(name) : ANYTHING_ELSE,
    reply_markup: {
      inline_keyboard: [[{ text: '⚔️ Играть', web_app: { url: appUrl } }]],
    },
  };
}

export interface ChatLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** One call to the Bot API. Throws on anything that is not `ok`. */
export async function callBotApi<T>(
  token: string,
  method: string,
  payload: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
  const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(`${method}: ${body.description ?? response.status}`);
  return body.result as T;
}

export interface ChatOptions {
  readonly token: string;
  /** Where the Mini App lives, e.g. https://warchestapp.example.com */
  readonly appUrl: string;
  readonly log: ChatLog;
  /** Seconds Telegram holds a poll open. Short in tests, 25 in life. */
  readonly pollSeconds?: number;
  /** Swappable so the loop can be tested without a network. */
  readonly call?: typeof callBotApi;
}

/**
 * Polls until stopped. Returns a handle rather than a promise: the server
 * starts this and gets on with serving.
 */
export function startChat(opts: ChatOptions): { stop(): void; done: Promise<void> } {
  const call = opts.call ?? callBotApi;
  const pollSeconds = opts.pollSeconds ?? 25;
  const abort = new AbortController();
  let offset = 0;

  const loop = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      try {
        const updates = await call<TelegramUpdate[]>(
          opts.token,
          'getUpdates',
          { offset, timeout: pollSeconds, allowed_updates: ['message'] },
          abort.signal,
        );
        for (const update of updates) {
          // Past this one whatever happens: an update that throws every time
          // would otherwise be answered forever.
          offset = Math.max(offset, update.update_id + 1);
          const reply = replyTo(update, opts.appUrl);
          if (!reply) continue;
          await call(opts.token, 'sendMessage', reply, abort.signal);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        opts.log.warn({ err: message }, 'Telegram chat poll failed');
        // 409 means another copy of this server is polling the same token.
        // Retrying faster will not win the argument, so wait either way.
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  return { stop: () => abort.abort(), done: loop() };
}
