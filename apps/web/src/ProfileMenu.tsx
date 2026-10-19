import { useEffect, useRef, useState } from 'react';
import './profile.css';

export function ProfileMenu({ name, role, onLogout }: { name: string; role: 'Faculty' | 'Student'; onLogout: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null); const item = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return; item.current?.focus();
    const outside = (event: PointerEvent) => { if (!busy && !root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', outside); return () => window.removeEventListener('pointerdown', outside);
  }, [open, busy]);
  return <div className="profile-menu" ref={root}>
    <button ref={trigger} className="profile-trigger" aria-label={`${role} profile: ${name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!busy) { setOpen(!open); setError(''); } }} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>
      <span className="profile-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg></span>
      <span className="profile-text"><strong title={name}>{name}</strong><small>{role === 'Student' ? 'Student view' : 'Faculty'}</small></span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div className="profile-dropdown" role="menu" aria-label={`${role} profile options`} onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); item.current?.focus(); }
      if (event.key === 'Tab' && !busy) setOpen(false);
    }}><button ref={item} role="menuitem" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onLogout(); setOpen(false); } catch (error) { setError(error instanceof Error ? error.message : 'Could not log out. Try again.'); } finally { setBusy(false); } }}>{busy ? 'Logging out…' : 'Log out'}</button>{error && <p role="alert" className="error">{error}</p>}</div>}
  </div>;
}
