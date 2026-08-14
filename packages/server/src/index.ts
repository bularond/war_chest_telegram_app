/**
 * The entry point, and nothing else.
 *
 * `ROLE` decides which half of the program runs, and the imports below are
 * dynamic so that the half that does not run is never even loaded. That is the
 * whole point of the chat role: it must not need the native engine, a database
 * file or a port to listen on, and a static import would drag in all three
 * before the first line of it ran.
 */

import { loadConfig } from './config.js';

const config = loadConfig();

if (config.role === 'chat') {
  const { runChat } = await import('./chat.js');
  await runChat(config);
} else {
  await import('./server.js');
}
