import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FacultyRoute } from './FacultyAuth';
import { ProfileMenu } from './ProfileMenu';

const anonymous = { authenticationRequired: true, authenticated: false, username: null, displayName: null };
const faculty = { authenticationRequired: true, authenticated: true, username: 'teacher', displayName: 'Test Faculty' };
const response = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

describe('Faculty sign-in UI', () => {
  it('does not request private records until signed in, displays the profile and refresh text, and returns to sign-in after logout', async () => {
    let signedIn = false;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/faculty/session') return response(signedIn ? faculty : anonymous);
      if (url === '/api/faculty/login') { signedIn = true; return response(faculty); }
      if (url === '/api/faculty/logout') { signedIn = false; return response(null, 204); }
      return response(url === '/api/storage' ? { storage: null } : { exams: [] });
    });
    const navigate = vi.fn(); vi.stubGlobal('fetch', mock); render(<FacultyRoute navigate={navigate} />);
    await screen.findByLabelText('Username');
    expect(mock.mock.calls.some(([url]) => url === '/api/exams')).toBe(false);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'teacher' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Faculty workspace' });
    const refresh = screen.getByRole('button', { name: 'Refresh exams' }); expect(refresh).toHaveTextContent('Refresh');
    fireEvent.click(refresh); await waitFor(() => expect(mock.mock.calls.filter(([url]) => url === '/api/exams').length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole('button', { name: 'Faculty profile: Test Faculty' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/faculty/login'));
    expect(screen.getByLabelText('Username')).toHaveValue(''); expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.queryByRole('heading', { name: 'Faculty workspace' })).not.toBeInTheDocument();
    const loginCall = mock.mock.calls.find(([url]) => url === '/api/faculty/login')!;
    expect(JSON.parse(loginCall[1]!.body as string)).toEqual({ username: 'teacher', password: 'test-password' });
    expect(sessionStorage.getItem('faculty-password')).toBeNull();
  });
  it('keeps private records hidden after a failed login and clears the password', async () => {
    const mock = vi.fn(async (url: string) => url === '/api/faculty/login' ? response({ error: { message: 'Incorrect faculty username or password.' } }, 401) : response(anonymous));
    vi.stubGlobal('fetch', mock); render(<FacultyRoute />); await screen.findByLabelText('Username');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'teacher' } }); fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); await screen.findByRole('alert');
    expect(screen.getByLabelText('Password')).toHaveValue(''); expect(mock.mock.calls.some(([url]) => url === '/api/exams')).toBe(false);
  });
  it('redirects an already signed-in faculty member from the login page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(faculty))); const navigate = vi.fn(); render(<FacultyRoute login navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/faculty'));
  });
  it('hides the workspace on logout in another tab or a session-expired event', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url === '/api/faculty/session' ? faculty : url === '/api/storage' ? { storage: null } : { exams: [] })));
    const { unmount } = render(<FacultyRoute />); await screen.findByRole('heading', { name: 'Faculty workspace' });
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'faculty-logout', newValue: '1' })));
    expect(screen.getByLabelText('Password')).toBeInTheDocument(); unmount();
    render(<FacultyRoute />); await screen.findByRole('heading', { name: 'Faculty workspace' });
    act(() => window.dispatchEvent(new Event('faculty-session-expired')));
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
  it('handles an unavailable session service without showing private records', async () => {
    const mock = vi.fn(async () => { throw new Error('Backend unavailable'); }); vi.stubGlobal('fetch', mock); render(<FacultyRoute />);
    await screen.findByText('Backend unavailable'); fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await waitFor(() => expect(mock.mock.calls.length).toBe(2));
    expect(screen.queryByRole('heading', { name: 'Faculty workspace' })).not.toBeInTheDocument();
  });
  it('does not lose an exam form when a background session check has a network error', async () => {
    let offline = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (url === '/api/faculty/session') { if (offline) throw new Error('Offline'); return response(faculty); } return response(url === '/api/storage' ? { storage: null } : { exams: [] }); }));
    render(<FacultyRoute />); await screen.findByLabelText('Exam name');
    fireEvent.change(screen.getByLabelText('Exam name'), { target: { value: 'Unsaved exam title' } }); offline = true;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.getByLabelText('Exam name')).toHaveValue('Unsaved exam title');
  });
});
describe('Profile menu', () => {
  it('supports keyboard navigation, Escape, outside dismissal and student logout', async () => {
    const logout = vi.fn(async () => {}); render(<ProfileMenu name="Anu Thomas" role="Student" onLogout={logout} />);
    const trigger = screen.getByRole('button', { name: 'Student profile: Anu Thomas' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' }); expect(trigger).toHaveFocus(); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger); fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' })); await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
  it('shows a failed-logout error rather than pretending the session ended', async () => {
    render(<ProfileMenu name="Teacher" role="Faculty" onLogout={async () => { throw new Error('Cannot log out while offline.'); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Faculty profile: Teacher' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await screen.findByRole('alert'); expect(screen.getByRole('menu')).toBeInTheDocument(); expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeEnabled();
  });
});
