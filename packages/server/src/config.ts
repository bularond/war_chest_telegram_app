/**
 * What a role is for.
 *
 * The two halves of this program want opposite things from a network. The Mini
 * App has to be reachable by the player's phone; the chat has to reach
 * `api.telegram.org`. Where those two are not the same place, they are run as
 * two deployments of the same image in two data centres, and this says which
 * one a process is.
 */
export const ROLES = ['app', 'chat', 'both'] as const;
export type Role = (typeof ROLES)[number];

export interface Config {
  /**
   * `app` serves the client and the game socket and never talks to Telegram.
   * `chat` only answers in chat: no port, no database, no game engine.
   * `both` is one process doing everything, and stays the default.
   */
  readonly role: Role;
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

function readRole(raw: string | undefined): Role {
  const value = raw?.trim().toLowerCase() || 'both';
  if (!(ROLES as readonly string[]).includes(value)) {
    throw new Error(`ROLE must be one of ${ROLES.join(', ')} — got "${value}"`);
  }
  return value as Role;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const role = readRole(env.ROLE);
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
  const isProd = env.NODE_ENV === 'production';

  if (isProd && !botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required when NODE_ENV=production');
  }
  /*
   * A chat-only process that cannot answer is worse than one that will not
   * start: it sits there polling and dropping every update on the floor, and
   * the only sign is a player wondering why the bot went quiet. Both of these
   * are the whole job of the role, so both are checked before anything runs.
   */
  if (role === 'chat' && !botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required when ROLE=chat');
  }
  if (role === 'chat' && !publicUrl) {
    throw new Error('PUBLIC_URL is required when ROLE=chat — the button needs an address');
  }

  return {
    role,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    botToken,
    clientDir: env.CLIENT_DIR ?? new URL('../../client/dist', import.meta.url).pathname,
    dbPath: env.DB_PATH ?? 'war-chest.db',
    devAuth: !botToken,
    publicUrl,
  };
}
