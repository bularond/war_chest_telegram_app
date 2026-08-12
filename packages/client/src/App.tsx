import { store, useApp } from './net.js';
import { CreateLobby, Hub, JoinByCode, LobbyList, LobbyRoom, PlayBot } from './screens/Menu.js';
import { GameScreen } from './screens/Game.js';
import { ProfileScreen, RulesScreen } from './screens/Info.js';

export function App() {
  const { screen, connected, error, view } = useApp();

  const body = (() => {
    switch (screen) {
      case 'list':
        return <LobbyList />;
      case 'code':
        return <JoinByCode />;
      case 'create':
        return <CreateLobby />;
      case 'bot':
        return <PlayBot />;
      case 'lobby':
        return <LobbyRoom />;
      case 'profile':
        return <ProfileScreen />;
      case 'rules':
        return <RulesScreen />;
      case 'game':
        return view ? <GameScreen /> : <Hub />;
      default:
        return <Hub />;
    }
  })();

  return (
    <>
      {body}
      {!connected ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            padding: '6px 12px',
            textAlign: 'center',
            fontSize: 12,
            background: 'var(--color-accent-200)',
            color: 'var(--color-accent-800)',
            zIndex: 60,
          }}
        >
          Нет связи с сервером — переподключаемся…
        </div>
      ) : null}
      {error && screen !== 'code' && screen !== 'list' ? (
        <button
          onClick={() => store.clearError()}
          style={{
            position: 'fixed',
            left: 16,
            right: 16,
            bottom: 16,
            padding: '10px 16px',
            borderRadius: 20,
            border: 'none',
            background: 'var(--color-accent-700)',
            color: 'var(--color-bg)',
            fontSize: 13,
            zIndex: 60,
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {error.message}
        </button>
      ) : null}
    </>
  );
}
