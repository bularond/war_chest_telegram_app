/** Lobby bookkeeping around a game in progress. */

import { describe, expect, it } from 'vitest';
import { Rooms } from './rooms.js';

const me = { userId: 'me', displayName: 'Артём К' };
const foe = { userId: 'foe', displayName: 'Марина С' };

describe('leaving a game in progress', () => {
  it('keeps the seat but stops pushing the table at whoever left', () => {
    const rooms = new Rooms();
    const lobby = rooms.create(me, { size: 2 });
    rooms.join(lobby.code, foe);
    rooms.start(lobby.code, me.userId);

    expect(rooms.seatedMembers(lobby).map((m) => m.userId)).toEqual(['me', 'foe']);

    rooms.leave(me.userId);
    // The seat is still there to come back to…
    expect(lobby.members.map((m) => m.userId)).toEqual(['me', 'foe']);
    // …but the table is no longer pushed at them. Without this the answer to
    // "leave" arrived together with the game view that put them straight back
    // on the game screen, and it took two taps to get out.
    expect(rooms.seatedMembers(lobby).map((m) => m.userId)).toEqual(['foe']);
    expect(rooms.lobbyOf(me.userId)).toBeUndefined();

    // Coming back seats them again.
    rooms.join(lobby.code, me);
    expect(rooms.seatedMembers(lobby).map((m) => m.userId)).toEqual(['me', 'foe']);
  });

  it('leaves nobody seated at a finished bot game the player walked out of', () => {
    const rooms = new Rooms();
    const lobby = rooms.create(me, { size: 2, vsBot: 'easy' });
    expect(lobby.game).not.toBeNull();

    rooms.leave(me.userId);
    expect(rooms.seatedMembers(lobby)).toEqual([]);
  });
});
