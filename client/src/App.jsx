import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, session } from './api.js';
import { describeConnectResult, takeFacebookRedirect } from './connect.js';
import { ConnectContext, SocketContext } from './components/common.jsx';
import { Auth } from './components/Auth.jsx';
import { Onboarding } from './components/Onboarding.jsx';
import { Inbox } from './components/Inbox.jsx';
import { ConnectDialog } from './components/ConnectDialog.jsx';

export function App() {
  // undefined while checking a saved session, null when signed out.
  const [me, setMe] = useState(session.token ? undefined : null);
  const [socket, setSocket] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingConnect, setPendingConnect] = useState(null);
  const [connectResult, setConnectResult] = useState('');
  const [resultVersion, setResultVersion] = useState(0);
  const [showReady, setShowReady] = useState(false);
  const redirectHandled = useRef(false);

  const signOut = useCallback(() => {
    session.set(null);
    setShowReady(false);
    setMe(null);
  }, []);

  const loadMe = useCallback(async () => setMe(await api('/me')), []);

  useEffect(() => {
    session.onUnauthorized(signOut);
    if (session.token) loadMe().catch(signOut);
  }, [loadMe, signOut]);

  // One real-time connection per signed-in session.
  const signedIn = Boolean(me);
  useEffect(() => {
    if (!signedIn) return undefined;
    const s = io({ auth: { token: session.token } });
    setSocket(s);
    return () => { s.disconnect(); setSocket(null); };
  }, [signedIn]);

  const showResult = useCallback((result) => {
    setConnectResult(describeConnectResult(result));
    setResultVersion((v) => v + 1);
  }, []);

  const onboarding = Boolean(me && me.user.role === 'owner' && (me.workspace.onboardingStep !== 'done' || showReady));

  // Facebook sends the owner back to /app?connect=<id> (or ?connect_error=...) after login.
  useEffect(() => {
    if (!me || redirectHandled.current) return;
    redirectHandled.current = true;
    const redirect = takeFacebookRedirect();
    if (!redirect || me.user.role !== 'owner') return;
    // During onboarding the picker opens over the wizard instead of Settings.
    if (!onboarding) setSettingsOpen(true);
    if (redirect.error) showResult({ problems: [redirect.error] });
    else setPendingConnect(redirect.id);
  }, [me, onboarding, showResult]);

  const connect = useMemo(() => ({
    settings: me?.connect,
    result: connectResult,
    resultVersion,
    showResult,
  }), [me?.connect, connectResult, resultVersion, showResult]);

  const setWorkspace = (workspace) => setMe((m) => ({ ...m, workspace }));

  async function signOutEverywhere() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    signOut();
  }

  // Reaching the "Ready" step already saves onboardingStep "done" (so a reload
  // opens the inbox), but the wizard stays up until the owner clicks through.
  const setOnboardingWorkspace = (workspace) => {
    if (workspace.onboardingStep === 'done') setShowReady(true);
    setWorkspace(workspace);
  };

  function finishOnboarding() {
    setShowReady(false);
  }

  if (me === undefined) return null;
  if (me === null) return <Auth onSignedIn={loadMe} />;

  return (
    <SocketContext.Provider value={socket}>
      <ConnectContext.Provider value={connect}>
        {onboarding ? (
          <Onboarding me={me} setWorkspace={setOnboardingWorkspace} onFinish={finishOnboarding} onSignOut={signOutEverywhere} />
        ) : (
          <Inbox me={me} setMe={setMe} onSignOut={signOut} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen} />
        )}
        <ConnectDialog pendingId={pendingConnect} onClose={() => setPendingConnect(null)} onResult={showResult} />
      </ConnectContext.Provider>
    </SocketContext.Provider>
  );
}
