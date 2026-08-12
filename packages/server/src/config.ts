export interface Config {
  readonly port: number;
  readonly host: string;
  readonly botToken: string | null;
  /** Serve the built client from this directory, when it exists. */
  readonly clientDir: string;
  readonly dbPath: string;
  /**
   * Without a bot token there is no way to verify Telegram's signature, so the
   * server accepts unsigned identities. Local development only — the server
   * refuses to start in production without a token.
   */
  readonly devAuth: boolean;
  /**
   * Where the Mini App answers from the outside, e.g.
   * `https://warchestapp.example.com`. The button the bot sends in chat has to
   * name an absolute https address, so without this the bot stays silent.
   */
  readonly publicUrl: string | null;
}

export function loadConfig(): Config {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const publicUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required when NODE_ENV=production');
  }
  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '0.0.0.0',
    botToken,
    clientDir: process.env.CLIENT_DIR ?? new URL('../../client/dist', import.meta.url).pathname,
    dbPath: process.env.DB_PATH ?? 'war-chest.db',
    devAuth: !botToken,
    publicUrl,
  };
}
