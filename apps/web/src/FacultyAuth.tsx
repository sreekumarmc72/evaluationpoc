import { useEffect, useRef, useState } from 'react';
import { FacultyPage } from './ExamPages';

type Session = { authenticationRequired: boolean; authenticated: boolean; username: string | null; displayName: string | null };
export const navigatePage = (path: string) => window.location.assign(path);
async function authRequest(url: string, body?: object): Promise<Session | null> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: controller.signal });
    if (response.status === 204) return null;
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? 'Could not complete faculty sign-in.');
    if (typeof value.authenticated !== 'boolean' || typeof value.authenticationRequired !== 'boolean' || !(typeof value.displayName === 'string' || value.displayName === null)) throw new Error('The server returned an invalid sign-in response.');
    return value;
  } catch (error) { if (controller.signal.aborted) throw new Error('The sign-in request timed out. Please try again.'); throw error; }
  finally { clearTimeout(timeout); }
}
export function FacultyRoute({ login = false, navigate = navigatePage }: { login?: boolean; navigate?: (path: string) => void }) {
  const generation = useRef(0);
  const [session, setSession] = useState<Session | null>(null); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => { const current = generation.current; try { const next = await authRequest('/api/faculty/session'); if (!cancelled && current === generation.current) { setSession(next); setError(''); } } catch (error) { if (!cancelled && current === generation.current) setError(error instanceof Error ? error.message : 'Cannot check faculty sign-in.'); } };
    const expire = () => { generation.current++; setUsername(''); setPassword(''); setSession({ authenticationRequired: true, authenticated: false, username: null, displayName: null }); };
    const storage = (event: StorageEvent) => { if (event.key === 'faculty-logout') expire(); };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) setSession(null); void load(); };
    void load(); const timer = setInterval(() => { void load(); }, 60000);
    window.addEventListener('focus', load); window.addEventListener('pageshow', pageShow); window.addEventListener('storage', storage); window.addEventListener('faculty-session-expired', expire);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener('pageshow', pageShow); window.removeEventListener('storage', storage); window.removeEventListener('faculty-session-expired', expire); };
  }, [revision]);
  useEffect(() => { if (login && session?.authenticated && session.authenticationRequired) navigate('/faculty'); }, [login, session?.authenticated, session?.authenticationRequired, navigate]);
  if (!login && session?.authenticated) return <FacultyPage facultyName={session.displayName || session.username || 'Faculty'} onLogout={async () => {
    generation.current++;
    await authRequest('/api/faculty/logout', {});
    generation.current++;
    setUsername(''); setPassword('');
    setSession({ authenticationRequired: session.authenticationRequired, authenticated: false, username: null, displayName: null });
    try { localStorage.setItem('faculty-logout', String(Date.now())); } catch { /* Other tabs also check their session on focus. */ }
    navigate('/faculty/login');
  }} />;
  return <div className="app-shell faculty-shell faculty-login-shell"><header><a href="/" className="faculty-brand"><img src="/branding/nergy-vidya.svg" alt="Nergy Vidya" width="100" height="56" /><span>Faculty sign in</span></a></header><main>
    <section className="upload-panel faculty-login-card"><h1>Faculty sign in</h1><p className="muted">Sign in to prepare exams and view student submissions.</p>
      {!session ? error ? <><p className="error" role="alert">{error}</p><button className="secondary" onClick={() => setRevision(value => value + 1)}>Retry connection</button></> : <p role="status">Checking sign-in…</p> : session.authenticated && session.authenticationRequired ? <p role="status">Opening faculty workspace…</p> : !session.authenticationRequired ? <><p className="notice">Faculty sign-in protection is disabled in this development instance.</p><button onClick={() => navigate('/faculty')}>Open faculty workspace</button></> : <form className="exam-form" onSubmit={async event => {
        event.preventDefault(); if (busy) return; setBusy(true); setError('');
        try { generation.current++; const next = await authRequest('/api/faculty/login', { username: username.trim(), password }); generation.current++; setSession(next); setPassword(''); }
        catch (error) { setError(error instanceof Error ? error.message : 'Could not sign in.'); setPassword(''); }
        finally { setBusy(false); }
      }}><label htmlFor="faculty-username">Username</label><input id="faculty-username" autoComplete="username" required maxLength={160} value={username} disabled={busy} onChange={event => setUsername(event.target.value)} /><label htmlFor="faculty-password">Password</label><input id="faculty-password" type="password" autoComplete="current-password" required maxLength={1024} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />{error && <p className="error" role="alert">{error}</p>}<button disabled={busy || !username.trim() || !password}>{busy ? 'Signing in…' : 'Sign in'}</button></form>}
    </section></main></div>;
}
