import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RunStore } from './store.js';

const cookieName = 'faculty_session';
const lifetime = 8 * 60 * 60 * 1000;
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const cookie = (req: Request, name: string) => (req.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) ?? '';

export function createFacultyAuth(options: { facultyPassword?: string; facultyUser?: string; facultyDisplayName?: string; requireFacultyAuth?: boolean; appOrigin?: string; store: RunStore }) {
  const enabled = !!options.facultyPassword || !!options.requireFacultyAuth;
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; expires: number }>();
  const username = options.facultyUser || 'faculty';
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  const sessionKey = (req: Request) => { const token = cookie(req, cookieName); return /^[a-f0-9]{64}$/.test(token) ? hash(token) : ''; };
  const isFaculty = (req: Request) => {
    if (!enabled) return true; // Preserve the existing unprotected local-development mode.
    const key = sessionKey(req); const expires = sessions.get(key);
    if (!expires || expires <= Date.now()) { if (key) sessions.delete(key); return false; }
    return true;
  };
  const sessionInfo = (req: Request) => {
    const authenticated = isFaculty(req);
    return { authenticationRequired: enabled, authenticated, username: authenticated ? username : null, displayName: authenticated ? options.facultyDisplayName || (enabled ? username : 'Faculty') : null };
  };
  const cookieOptions = (req: Request) => ({ path: '/', httpOnly: true, sameSite: 'strict' as const, secure: req.secure || !!options.appOrigin?.startsWith('https://') });
  const deny = (req: Request, res: Response) => {
    if (/^\/faculty(?:\/|$)/i.test(req.path) && ['GET', 'HEAD'].includes(req.method)) { res.redirect(302, '/faculty/login'); return; }
    if (!options.facultyPassword) { res.status(503).json({ error: { code: 'FACULTY_ACCESS_NOT_CONFIGURED', message: 'Set FACULTY_PASSWORD in the server environment before accessing faculty records.' } }); return; }
    res.status(401).json({ error: { code: 'FACULTY_ACCESS_REQUIRED', message: 'Faculty sign-in is required.' } });
  };
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const route = req.path.toLowerCase();
    if (route.replace(/\/$/, '') === '/faculty/login' && ['GET', 'HEAD'].includes(req.method)) return next();
    const studentRoute = /^\/api\/exams\/[^/]+\/student\/?$/.test(route) && req.method === 'GET';
    const uploadRoute = /^\/api\/exams\/[^/]+\/evaluations\/?$/.test(route) && req.method === 'POST';
    if (/^\/faculty(?:\/|$)/.test(route) || (/^\/api\/exams(?:\/|$)/.test(route) && !studentRoute && !uploadRoute) || route === '/api/storage') {
      if (!isFaculty(req)) { deny(req, res); return; }
    }
    const id = /^\/api\/evaluations\/([^/]+)/.exec(route)?.[1];
    if (id && options.store.isSaved(id) && !isFaculty(req)) {
      const nameUpdate = req.method === 'PATCH' && /^\/api\/evaluations\/[^/]+\/student-name\/?$/.test(route);
      if (req.method === 'PATCH' && !nameUpdate) { deny(req, res); return; }
      if (!options.store.hasAccess(id, cookie(req, 'submission_access'))) { res.status(401).json({ error: { code: 'SUBMISSION_ACCESS_REQUIRED', message: 'This submission requires its original browser session or faculty sign-in.' } }); return; }
    }
    next();
  };
  const registerRoutes = (app: Express) => {
    app.get('/api/faculty/session', (req, res) => res.json(sessionInfo(req)));
    app.post('/api/faculty/login', express.json({ limit: '3kb' }), (req, res) => {
      if (!options.facultyPassword) { res.status(503).json({ error: { code: 'FACULTY_ACCESS_NOT_CONFIGURED', message: 'Faculty sign-in credentials are not configured on this server.' } }); return; }
      for (const [key, value] of failures) if (value.expires <= Date.now()) failures.delete(key);
      const ip = req.ip || 'unknown'; const failed = failures.get(ip);
      if ((failed?.count ?? 0) >= 10 || (!failed && failures.size >= 1000)) { res.set('Retry-After', '60').status(429).json({ error: { code: 'LOGIN_RATE_LIMIT', message: 'Too many sign-in attempts. Wait a minute before trying again.' } }); return; }
      const input = z.object({ username: z.string().trim().min(1).max(160), password: z.string().min(1).max(1024) }).strict().safeParse(req.body);
      if (!input.success) { res.status(400).json({ error: { code: 'INVALID_LOGIN', message: 'Enter your faculty username and password.' } }); return; }
      if (!same(input.data.username, username) || !same(input.data.password, options.facultyPassword)) {
        failures.set(ip, { count: (failed?.count ?? 0) + 1, expires: failed?.expires ?? Date.now() + 60000 });
        res.status(401).json({ error: { code: 'INVALID_LOGIN', message: 'Incorrect faculty username or password.' } }); return;
      }
      for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
      if (sessions.size >= 1000) { res.status(503).json({ error: { code: 'SESSION_LIMIT', message: 'The sign-in service is busy. Please try again later.' } }); return; }
      failures.delete(ip); sessions.delete(sessionKey(req));
      const token = randomBytes(32).toString('hex'); sessions.set(hash(token), Date.now() + lifetime);
      res.cookie(cookieName, token, { ...cookieOptions(req), maxAge: lifetime });
      res.json({ authenticationRequired: enabled, authenticated: true, username, displayName: options.facultyDisplayName || username });
    });
    app.post('/api/faculty/logout', (req, res) => {
      sessions.delete(sessionKey(req)); res.clearCookie(cookieName, cookieOptions(req)); res.status(204).end();
    });
  };
  return { middleware, registerRoutes };
}
