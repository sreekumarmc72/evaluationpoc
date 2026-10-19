import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { createApp } from './app.js';
import { RunStore } from './store.js';
import { ExamCatalog } from './exam-catalog.js';
import { examFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';
import { directResolution } from './validation.js';
import type { EvaluationModel } from './model.js';

let root: string; let store: RunStore; let catalog: ExamCatalog; let pdf: Buffer;
const password = 'local-test-password';
const spec = () => { const exam = examFixture(); for (const q of exam.questions) q.rubric = [{ id: 'answer', description: 'Answer', maximumMarks: q.maximumMarks, expectedEvidence: q.expectedAnswer, keyAlignment: 'Key', allocationBasis: 'inferred' }]; return exam; };
const model: EvaluationModel = {
  extract: vi.fn(async () => ({ value: spec(), usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })),
  transcribe: vi.fn(async () => ({ value: transcriptionFixture(), usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })),
  resolve: vi.fn(async (_sheet, _questions, t) => ({ value: directResolution(t, spec()), usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })),
  grade: vi.fn(async () => ({ value: { results: gradingFixture().results.map(r => ({ ...r, criterionAwards: [{ criterionId: 'answer', marks: r.marks, evidence: 'Observed answer', reason: 'Correct answer', sourceEntryIds: [r.identifier === '1' ? 'entry-1' : 'entry-2'] }] })), warnings: [] }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })),
};
function appFor(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ store, examCatalog: catalog, model, models: { 'gpt-6.1-sol': model }, configured: true, modelId: 'gpt-6.1-sol', maxBytes: 100000, maxPages: 10, retentionMs: 3600000, facultyUser: 'teacher', facultyPassword: password, facultyDisplayName: 'Test Faculty', requireFacultyAuth: true, webRoot: path.join(root, 'web'), ...extra });
}
const cookieFrom = (response: { headers: Record<string, any> }) => response.headers['set-cookie'][0].split(';')[0] as string;
async function prepared() {
  const metadata = await catalog.create('Saved exam', 'gpt-6.1-sol', { questionPaper: { name: 'paper.pdf', buffer: pdf, pages: 1 }, answerKey: { name: 'key.pdf', buffer: pdf, pages: 1 } });
  await catalog.ready(metadata.id, spec(), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, 1); return metadata.id;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'faculty-session-test-'));
  store = new RunStore(path.join(root, 'runs'), 3600000, path.join(root, 'submissions')); await store.initialize();
  catalog = new ExamCatalog(path.join(root, 'exams')); await catalog.initialize();
  await mkdir(path.join(root, 'web')); await writeFile(path.join(root, 'web', 'index.html'), '<html>Test application</html>');
  const doc = await PDFDocument.create(); doc.addPage(); pdf = Buffer.from(await doc.save());
});
afterEach(async () => { vi.restoreAllMocks(); await store.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('Faculty sessions', () => {
  it('requires sign-in, uses an HttpOnly cookie, and revokes it on logout without accepting cached Basic credentials', async () => {
    const app = appFor();
    expect((await request(app).get('/api/faculty/session')).body).toMatchObject({ authenticated: false, username: null, displayName: null });
    expect((await request(app).get('/faculty')).headers.location).toBe('/faculty/login');
    expect((await request(app).get('/faculty/login')).status).toBe(200);
    const blocked = await request(app).get('/api/exams'); expect(blocked.status).toBe(401); expect(blocked.headers['www-authenticate']).toBeUndefined();
    expect((await request(app).get('/api/exams').auth('teacher', password)).status).toBe(401);
    const login = await request(app).post('/api/faculty/login').send({ username: 'teacher', password });
    expect(login.status).toBe(200); expect(login.body).toMatchObject({ authenticated: true, displayName: 'Test Faculty', username: 'teacher' });
    const cookie = cookieFrom(login); expect(login.headers['set-cookie'][0]).toContain('HttpOnly'); expect(login.headers['set-cookie'][0]).toContain('SameSite=Strict');
    expect(login.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(login.body)).not.toContain(password);
    expect((await request(app).get('/api/exams').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/faculty/session').set('Cookie', cookie)).body.authenticated).toBe(true);
    const logout = await request(app).post('/api/faculty/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204); expect(logout.headers['set-cookie'][0]).toMatch(/faculty_session=;/);
    expect(logout.headers['set-cookie'][0]).not.toContain('submission_access');
    expect((await request(app).get('/api/exams').set('Cookie', cookie).auth('teacher', password)).status).toBe(401);
    expect((await request(app).get('/api/faculty/session').set('Cookie', cookie)).body.authenticated).toBe(false);
    expect((await request(app).get('/faculty').set('Cookie', cookie)).status).toBe(302);
    expect((await request(app).post('/api/faculty/login').send({ username: 'teacher', password: 'wrong' })).status).toBe(401);
    expect((await request(app).post('/api/faculty/login').send({ username: 'teacher', password })).status).toBe(200);
  });
  it('keeps student access, saved history and public exam links intact after faculty logout', async () => {
    const id = await prepared(); const app = appFor();
    const run = await store.create({ answerSheet: pdf }, 'gpt-6.1-sol', { examId: id, examVersion: 1, exam: spec() });
    const studentCookie = 'submission_access=' + store.takeAccessToken(run.id)!;
    run.stage = 'completed'; run.finishedAt = Date.now(); await store.checkpoint(run);
    const login = await request(app).post('/api/faculty/login').send({ username: 'teacher', password }); const facultyCookie = cookieFrom(login);
    expect((await request(app).get(`/api/evaluations/${run.id}`).set('Cookie', facultyCookie)).status).toBe(200);
    await request(app).post('/api/faculty/logout').set('Cookie', facultyCookie);
    expect((await request(app).get(`/api/exams/${id}/student`)).status).toBe(200);
    expect((await request(app).get(`/api/exams/${id}/submissions`).set('Cookie', facultyCookie)).status).toBe(401);
    expect((await request(app).get(`/api/evaluations/${run.id}`).set('Cookie', facultyCookie)).status).toBe(401);
    expect((await request(app).get(`/api/evaluations/${run.id}`).set('Cookie', studentCookie)).status).toBe(200);
    expect((await request(app).get(`/api/evaluations/${run.id}/answer-sheet`).set('Cookie', studentCookie)).status).toBe(200);
    expect(store.list(id)).toHaveLength(1); expect(catalog.get(id).metadata.name).toBe('Saved exam');
    expect((await request(app).get('/student/' + id)).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
  });
  it('does not cancel an evaluation when faculty logs out', async () => {
    const id = await prepared(); const app = appFor();
    const login = await request(app).post('/api/faculty/login').send({ username: 'teacher', password });
    const submitted = await request(app).post(`/api/exams/${id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf'); expect(submitted.status).toBe(202);
    await request(app).post('/api/faculty/logout').set('Cookie', cookieFrom(login));
    for (let i = 0; i < 100 && store.get(submitted.body.id)?.stage !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(store.get(submitted.body.id)?.stage).toBe('completed'); expect(store.get(submitted.body.id)?.totals?.totalMarks).toBe(5);
  });
  it('rotates session IDs, expires sessions and does not persist authentication through a server restart', async () => {
    const app = appFor(); const first = await request(app).post('/api/faculty/login').send({ username: 'teacher', password }); const firstCookie = cookieFrom(first);
    const second = await request(app).post('/api/faculty/login').set('Cookie', firstCookie).send({ username: 'teacher', password }); const secondCookie = cookieFrom(second);
    expect(secondCookie).not.toBe(firstCookie); expect((await request(app).get('/api/exams').set('Cookie', firstCookie)).status).toBe(401);
    expect((await request(appFor()).get('/api/exams').set('Cookie', secondCookie)).status).toBe(401);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 3600000 + 1000);
    expect((await request(app).get('/api/exams').set('Cookie', secondCookie)).status).toBe(401);
  });
  it('rejects foreign-origin login/logout, malformed credentials and throttles repeated failures', async () => {
    const app = appFor();
    expect((await request(app).post('/api/faculty/login').set('Origin', 'https://evil.example').send({ username: 'teacher', password })).status).toBe(403);
    expect((await request(app).post('/api/faculty/logout').set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app).post('/api/faculty/login').send({ username: 'teacher', password, extra: true })).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await request(app).post('/api/faculty/login').send({ username: 'teacher', password: 'wrong' })).status).toBe(401);
    const blocked = await request(app).post('/api/faculty/login').send({ username: 'teacher', password }); expect(blocked.status).toBe(429); expect(blocked.headers['retry-after']).toBe('60');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    expect((await request(app).post('/api/faculty/login').send({ username: 'teacher', password })).status).toBe(200);
  });
  it('uses Secure cookies for HTTPS and fails closed when hosted credentials are missing', async () => {
    const app = appFor({ appOrigin: 'https://poc.example' }); const login = await request(app).post('/api/faculty/login').send({ username: 'teacher', password });
    expect(login.headers['set-cookie'][0]).toContain('Secure');
    const missing = appFor({ facultyPassword: undefined, requireFacultyAuth: true });
    expect((await request(missing).get('/api/exams')).status).toBe(503);
    expect((await request(missing).post('/api/faculty/login').send({ username: 'teacher', password })).status).toBe(503);
    expect((await request(missing).get('/faculty/login')).status).toBe(200);
    const local = appFor({ facultyPassword: undefined, requireFacultyAuth: false });
    expect((await request(local).get('/api/exams')).status).toBe(200);
    expect((await request(local).get('/api/faculty/session')).body.authenticationRequired).toBe(false);
  });
});
