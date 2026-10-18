import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RunStore } from './store.js';

export function facultyAccess(options: { facultyPassword?: string; facultyUser?: string; requireFacultyAuth?: boolean; store: RunStore }) {
  const enabled = !!options.facultyPassword || !!options.requireFacultyAuth;
  const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  const isFaculty = (req: Request) => {
    if (!enabled) return true;
    if (!options.facultyPassword) return false;
    const header = req.get('authorization') ?? '';
    if (!header.startsWith('Basic ') || header.length > 4096) return false;
    const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8'); const separator = credentials.indexOf(':');
    return separator >= 0 && same(credentials.slice(0, separator), options.facultyUser || 'faculty') && same(credentials.slice(separator + 1), options.facultyPassword);
  };
  const deny = (_req: Request, res: Response) => {
    if (!options.facultyPassword) { res.status(503).json({ error: { code: 'FACULTY_ACCESS_NOT_CONFIGURED', message: 'Set FACULTY_PASSWORD in the server environment before accessing faculty records.' } }); return; }
    res.set('WWW-Authenticate', 'Basic realm="Paperwise faculty", charset="UTF-8"').status(401).json({ error: { code: 'FACULTY_ACCESS_REQUIRED', message: 'Faculty sign-in is required.' } });
  };
  return (req: Request, res: Response, next: NextFunction) => {
    // Express routes are case-insensitive by default; authorization must match that behavior.
    const route = req.path.toLowerCase();
    const studentRoute = /^\/api\/exams\/[^/]+\/student\/?$/.test(route) && req.method === 'GET';
    const uploadRoute = /^\/api\/exams\/[^/]+\/evaluations\/?$/.test(route) && req.method === 'POST';
    if (/^\/faculty(?:\/|$)/.test(route) || (/^\/api\/exams(?:\/|$)/.test(route) && !studentRoute && !uploadRoute) || route === '/api/storage') {
      if (!isFaculty(req)) { deny(req, res); return; }
    }
    const id = /^\/api\/evaluations\/([^/]+)/.exec(route)?.[1];
    if (id && options.store.isSaved(id) && !isFaculty(req)) {
      if (req.method === 'PATCH') { deny(req, res); return; }
      const cookie = (req.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('submission_access='))?.slice('submission_access='.length) ?? '';
      if (!options.store.hasAccess(id, cookie)) { res.status(401).json({ error: { code: 'SUBMISSION_ACCESS_REQUIRED', message: 'This submission requires its original browser session or faculty sign-in.' } }); return; }
    }
    next();
  };
}
