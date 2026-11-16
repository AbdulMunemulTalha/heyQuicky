import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, session } from './api.js';
import { describeConnectResult, takeFacebookRedirect } from './connect.js';
import { ConnectContext, SocketContext } from './components/common.jsx';
import { Auth } from './components/Auth.jsx';
import { Onboarding, STEPS, stepIndex } from './components/Onboarding.jsx';
import { Inbox } from './components/Inbox.jsx';
import { ConnectFlow } from './components/ConnectFlow.jsx';

export function App() {
  // undefined while checking a saved session, null when signed out.
  const [me, setMe] = useState(session.token ? undefined : null);
  const [socket, setSocket] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The connect popup: { kind, mode?, pendingId? } while open.
  const [connectStart, setConnectStart] = useState(null);
  const [connectResult, setConnectResult] = useState('');
  const [resultVersion, setResultVersion] = useState(0);
  // "Save & exit" leaves onboarding for the inbox; remembered per shop until they resume.
  const [setupPaused, setSetupPaused] = useState(false);
  const redirectHandled = useRef(false);

  const signOut = useCallback(() => {
    session.set(null);
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

  const pauseKey = me ? `quicky:setup-paused:${me.workspace.id}` : null;
  useEffect(() => { if (pauseKey) setSetupPaused(localStorage.getItem(pauseKey) === '1'); }, [pauseKey]);
  const setupOpen = Boolean(me && me.user.role === 'owner' && me.workspace.onboardingStep !== 'done');
  const onboarding = setupOpen && !setupPaused;

  // Facebook sends the owner back to /app?connect=<id> (or ?connect_error=...) after login.
  useEffect(() => {
    if (!me || redirectHandled.current) return;
    redirectHandled.current = true;
    const redirect = takeFacebookRedirect();
    if (!redirect || me.user.role !== 'owner') return;
    // During onboarding the popup opens over the wizard instead of Settings.
    if (!onboarding) setSettingsOpen(true);
    if (redirect.error) showResult({ problems: [redirect.error] });
    else setConnectStart({ kind: 'facebook', pendingId: redirect.id });
  }, [me, onboarding, showResult]);

  const connect = useMemo(() => ({
    settings: me?.connect,
    result: connectResult,
    resultVersion,
    showResult,
    open: (kind, options = {}) => setConnectStart({ kind, ...options }),
  }), [me?.connect, connectResult, resultVersion, showResult]);

  const setWorkspace = (workspace) => setMe((m) => ({ ...m, workspace }));

  async function signOutEverywhere() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    signOut();
  }

  function pauseSetup(paused) {
    if (paused) localStorage.setItem(pauseKey, '1');
    else localStorage.removeItem(pauseKey);
    setSetupPaused(paused);
  }

  if (me === undefined) return null;
  if (me === null) return <Auth onSignedIn={loadMe} />;

  return (
    <SocketContext.Provider value={socket}>
      <ConnectContext.Provider value={connect}>
        {onboarding ? (
          <Onboarding me={me} setWorkspace={setWorkspace} onFinish={() => pauseSetup(false)}
            onSaveExit={() => pauseSetup(true)} onSignOut={signOutEverywhere} />
        ) : (
          <>
            <Inbox me={me} setMe={setMe} onSignOut={signOut} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen} />
            {setupOpen && (
              <button type="button" className="resume-setup" onClick={() => pauseSetup(false)}>
                Finish setting up · step {stepIndex(me.workspace.onboardingStep) + 1} of {STEPS.length} →
              </button>
            )}
          </>
        )}
        <ConnectFlow
          start={connectStart}
          me={me}
          onboarding={onboarding}
          onClose={() => { setConnectStart(null); setResultVersion((v) => v + 1); }}
          // From the onboarding "Connect channels" step: move on to the next step.
          onContinueSetup={onboarding && me.workspace.onboardingStep === 'channels'
            ? () => api('/workspace', { method: 'PATCH', body: { onboardingStep: 'business' } }).then(setWorkspace).catch(() => {}) : undefined}
        />
      </ConnectContext.Provider>
    </SocketContext.Provider>
  );
}
