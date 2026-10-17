import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { mkdtemp, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { RunStore } from './store.js';
import { AppError } from './errors.js';
import type { EvaluationModel } from './model.js';
import { createStageRoutedModel } from './model.js';
import { directResolution } from './validation.js';
import { examFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';
import { RetainedExamStore } from './retained-exam.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
let store: RunStore; let root: string; let pdf: Buffer;
const fakeModel = (): EvaluationModel => ({ extract: vi.fn(async () => ({ value: examFixture(), usage })), transcribe: vi.fn(async () => ({ value: transcriptionFixture(), usage })), resolve: vi.fn(async (_sheet, _questions, t) => ({ value: directResolution(t, examFixture()), usage })), grade: vi.fn(async () => ({ value: gradingFixture(), usage })) });
const appFor = (model = fakeModel(), configured = true) => createApp({ store, model, modelId: 'test-sol', configured, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
function upload(app: ReturnType<typeof createApp>) { return request(app).post('/api/evaluations').attach('questionPaper', pdf, 'paper.pdf').attach('answerKey', pdf, 'key.pdf').attach('answerSheet', pdf, 'sheet.pdf'); }
async function finished(app: ReturnType<typeof createApp>, id: string) {
  for (let i = 0; i < 100; i++) { const response = await request(app).get(`/api/evaluations/${id}`); if (['completed', 'failed'].includes(response.body.stage)) return response.body; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Run did not finish.');
}
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'evaluation-test-')); store = new RunStore(root, 3600000); const doc = await PDFDocument.create(); doc.addPage(); pdf = Buffer.from(await doc.save()); });
afterEach(async () => { await store.dispose(); });
describe('Evaluation API', () => {
  it('serves all production pages and assets without exposing API fallbacks or local documents', async () => {
    const webRoot = path.join(root, 'web');
    await mkdir(path.join(webRoot, 'assets'), { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), '<html>Paperwise app</html>');
    await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log("app");');
    await writeFile(path.join(root, 'secret.pdf'), 'private document');
    const app = createApp({ store, model: fakeModel(), modelId: 'test-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000, webRoot, appOrigin: 'https://paperwise.up.railway.app' });
    for (const route of ['/', '/faculty', '/faculty/', '/student', '/student/', '/student/11111111-1111-4111-8111-111111111111', '/student/11111111-1111-4111-8111-111111111111/']) {
      const page = await request(app).get(route);
      expect(page.status).toBe(200); expect(page.text).toContain('Paperwise app');
    }
    expect((await request(app).get('/assets/app.js')).status).toBe(200);
    expect((await request(app).get('/api/health')).body.ok).toBe(true);
    for (const route of ['/api/unknown', '/secret.pdf', '/.env', '/exams/secret.pdf', '/unrecognised-page']) {
      expect((await request(app).get(route)).status).toBe(404);
    }
    expect((await request(app).post('/api/evaluations').set('Origin', 'https://paperwise.up.railway.app')).status).toBe(400);
    expect((await request(app).post('/api/evaluations').set('Origin', 'https://other.up.railway.app')).status).toBe(403);
    expect((await request(app).post('/api/evaluations').set('Origin', 'http://localhost:5173')).status).toBe(403);
  });
  it('retains exam PDFs for sheet-only submissions, supports replacement and clearing, and leaves invalid replacements untouched', async () => {
    const retainedExam = new RetainedExamStore(path.join(root, 'saved-exam'));
    const model = fakeModel();
    const app = createApp({ store, retainedExam, model, modelId: 'test-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
    expect((await request(app).post('/api/evaluations').attach('answerSheet', pdf, 'sheet.pdf')).status).toBe(400);
    const initial = await upload(app); expect(initial.body.retainedExam.questionPaper.name).toBe('paper.pdf'); await finished(app, initial.body.id);
    await request(app).delete(`/api/evaluations/${initial.body.id}`);
    expect((await request(app).get('/api/health')).body.retainedExam.answerKey.name).toBe('key.pdf');
    const next = await request(app).post('/api/evaluations').attach('answerSheet', pdf, 'another-sheet.pdf');
    expect(next.status).toBe(202); await finished(app, next.body.id);
    expect(await store.read(next.body.id, 'questionPaper')).toEqual(pdf);
    const invalid = await request(app).post('/api/evaluations').attach('answerKey', Buffer.from('invalid'), 'bad.pdf').attach('answerSheet', pdf, 'sheet.pdf');
    expect(invalid.status).toBe(400); expect((await retainedExam.read())!.answerKey.name).toBe('key.pdf');
    const replacement = await request(app).post('/api/evaluations').attach('answerKey', pdf, 'revised-key.pdf').attach('answerSheet', pdf, 'sheet.pdf');
    expect(replacement.status).toBe(202); await finished(app, replacement.body.id);
    expect((await request(app).get('/api/health')).body.retainedExam).toMatchObject({ questionPaper: { name: 'paper.pdf' }, answerKey: { name: 'revised-key.pdf' } });
    const reopened = new RetainedExamStore(path.join(root, 'saved-exam')); expect((await reopened.read())!.answerKey.name).toBe('revised-key.pdf');
    store.reserve(); expect((await request(app).delete('/api/exam')).status).toBe(409); store.release();
    expect((await reopened.read())!.answerKey.name).toBe('revised-key.pdf');
    expect((await request(app).delete('/api/exam')).status).toBe(204);
    expect((await request(app).get('/api/health')).body.retainedExam).toBeNull();
    expect((await request(app).post('/api/evaluations').attach('answerSheet', pdf, 'sheet.pdf')).status).toBe(400);
  });
  it('offers and routes the Ultrafast profile while preserving the actual stage model identifier', async () => {
    const sol = fakeModel(); const ultra = fakeModel();
    ultra.stageModels = Object.fromEntries(['extracting_exam', 'transcribing', 'resolving_answers', 'evaluating'].map(stage => [stage, 'gpt-6.1-sol']));
    const app = createApp({ store, model: sol, modelId: 'gpt-6.1-sol', models: { 'gpt-6.1-sol': sol, 'sol-ultrafast': ultra }, configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
    expect((await request(app).get('/api/health')).body.models).toContain('sol-ultrafast');
    const response = await upload(app).field('model', 'sol-ultrafast'); expect(response.status).toBe(202);
    const result = await finished(app, response.body.id);
    expect(result.model).toBe('sol-ultrafast'); expect(result.stage).toBe('completed'); expect(result.stageModels.evaluating).toBe('gpt-6.1-sol');
    expect(ultra.extract).toHaveBeenCalled(); expect(ultra.transcribe).toHaveBeenCalled(); expect(ultra.grade).toHaveBeenCalled(); expect(sol.extract).not.toHaveBeenCalled();
  });
  it('uses Luna for reading and resolution and Sol only for grading in mixed mode', async () => {
    const sol = fakeModel(); const luna = fakeModel();
    const t = transcriptionFixture(); t.answers[1].identifier = '6';
    luna.transcribe = vi.fn(async () => ({ value: t, usage }));
    luna.resolve = vi.fn(async () => ({ value: directResolution(transcriptionFixture(), examFixture()), usage }));
    const app = createApp({ store, model: sol, modelId: 'gpt-6.1-sol', models: { 'gpt-6.1-sol': sol, 'gpt-6-luna': luna, 'luna-sol': createStageRoutedModel(luna, sol) }, configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
    const response = await upload(app).field('model', 'luna-sol');
    expect(response.status).toBe(202);
    const result = await finished(app, response.body.id);
    expect(result.stage).toBe('completed'); expect(result.model).toBe('luna-sol');
    expect(result.stageModels).toEqual({ extracting_exam: 'gpt-6-luna', transcribing: 'gpt-6-luna', resolving_answers: 'gpt-6-luna', evaluating: 'gpt-6.1-sol' });
    expect(luna.extract).toHaveBeenCalled(); expect(luna.transcribe).toHaveBeenCalled(); expect(luna.resolve).toHaveBeenCalled(); expect(luna.grade).not.toHaveBeenCalled();
    expect(sol.grade).toHaveBeenCalled(); expect(sol.extract).not.toHaveBeenCalled(); expect(sol.transcribe).not.toHaveBeenCalled(); expect(sol.resolve).not.toHaveBeenCalled();
    expect(result.usage.totalTokens).toBe(60);
  });
  it('runs all stages with the selected model and rejects unlisted or repeated model fields', async () => {
    const sol = fakeModel(); const luna = fakeModel();
    const app = createApp({ store, model: sol, modelId: 'gpt-6.1-sol', models: { 'gpt-6.1-sol': sol, 'gpt-6-luna': luna }, configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
    expect((await request(app).get('/api/health')).body.models).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect((await upload(app).field('model', 'unknown')).status).toBe(400);
    expect((await upload(app).field('model', 'gpt-6-luna').field('model', 'gpt-6.1-sol')).status).toBe(400);
    expect((await upload(app).field('unexpected', 'value')).status).toBe(400);
    const response = await upload(app).field('model', 'gpt-6-luna');
    expect(response.status).toBe(202);
    const result = await finished(app, response.body.id);
    expect(result.model).toBe('gpt-6-luna');
    expect(luna.extract).toHaveBeenCalled(); expect(luna.transcribe).toHaveBeenCalled(); expect(luna.grade).toHaveBeenCalled();
    expect(sol.extract).not.toHaveBeenCalled();
    const fallback = await upload(app); await finished(app, fallback.body.id);
    expect(sol.extract).toHaveBeenCalled();
  });
  it('saves bounded teacher marks while preserving AI evidence and recalculating totals', async () => {
    const app = appFor(); const response = await upload(app); const run = await finished(app, response.body.id);
    const url = `/api/evaluations/${run.id}/questions/1`;
    expect((await request(app).patch(url).send({ marks: 3, reason: 'Too high' })).status).toBe(400);
    expect((await request(app).patch(url).send({ marks: 1, reason: '' })).status).toBe(400);
    const updated = await request(app).patch(url).send({ marks: 1.5, reason: 'Checked original scan.' });
    expect(updated.status).toBe(200);
    expect(updated.body.results[0].marks).toBe(2);
    expect(updated.body.results[0].teacherAdjustment.marks).toBe(1.5);
    expect(updated.body.totals.totalMarks).toBe(4.5);
    expect(updated.body.results[0].justification).toBe(run.results[0].justification);
    expect((await request(app).patch(`/api/evaluations/${run.id}/questions/99`).send({ marks: 1, reason: 'Checked' })).status).toBe(404);
  });
  it('runs all stages, exposes results and serves/removes the original PDF', async () => {
    const model = fakeModel(); const app = appFor(model);
    const response = await upload(app); expect(response.status).toBe(202);
    const run = await finished(app, response.body.id);
    expect(run.stage).toBe('completed'); expect(run.totals.totalMarks).toBe(5); expect(run.usage.totalTokens).toBe(45);
    expect(model.transcribe).toHaveBeenCalledWith(pdf);
    expect(model.resolve).not.toHaveBeenCalled();
    expect(run.transcription.answers[0].entryId).toBe('entry-1');
    expect((await request(app).get(`/api/evaluations/${run.id}/answer-sheet`)).headers['content-type']).toMatch(/application\/pdf/);
    expect((await request(app).delete(`/api/evaluations/${run.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/evaluations/${run.id}`)).status).toBe(404);
    await expect(access(path.join(root, run.id))).rejects.toThrow();
  });
  it('runs the conditional resolver and preserves raw labels with its usage and duration', async () => {
    const model = fakeModel(); const t = transcriptionFixture(); t.answers[1].identifier = '6';
    model.transcribe = vi.fn(async () => ({ value: t, usage }));
    const r = directResolution(transcriptionFixture(), examFixture());
    r.mappings[1].evidence = 'The heading and continuous working identify question 2(a).';
    model.resolve = vi.fn(async () => ({ value: r, usage }));
    const app = appFor(model); const response = await upload(app); const run = await finished(app, response.body.id);
    expect(run.stage).toBe('completed'); expect(run.usage.totalTokens).toBe(60);
    expect(run.transcription.answers[1].identifier).toBe('6');
    expect(run.resolvedTranscription.answers[1].identifier).toBe('2(a)');
    expect(run.stageDurations.resolving_answers).toBeGreaterThanOrEqual(0);
    expect(model.resolve).toHaveBeenCalledWith(pdf, examFixture().questions.map(({ identifier, text }) => ({ identifier, text })), expect.anything());
  });
  it('reports resolver failures with raw transcription still available and releases the run slot', async () => {
    const model = fakeModel(); const t = transcriptionFixture(); t.answers[1].identifier = null;
    model.transcribe = async () => ({ value: t, usage });
    model.resolve = async () => { throw new AppError('MODEL_TIMEOUT', 'Resolution timed out.'); };
    const app = appFor(model); const response = await upload(app); const run = await finished(app, response.body.id);
    expect(run.error.stage).toBe('resolving_answers');
    expect(run.transcription.answers[1].identifier).toBeNull(); expect(run.results).toEqual([]);
    const next = await upload(app); expect(next.status).toBe(202); await finished(app, next.body.id);
  });
  it('rejects missing, extra, duplicate and non-PDF uploads, and releases the slot', async () => {
    const app = appFor();
    expect((await request(app).post('/api/evaluations').attach('questionPaper', pdf, 'p.pdf')).status).toBe(400);
    expect((await upload(app).attach('other', pdf, 'extra.pdf')).status).toBe(400);
    expect((await upload(app).attach('answerKey', pdf, 'duplicate.pdf')).status).toBe(400);
    const bad = await request(app).post('/api/evaluations').attach('questionPaper', Buffer.from('evil'), 'paper.pdf').attach('answerKey', pdf, 'k.pdf').attach('answerSheet', pdf, 's.pdf');
    expect(bad.status).toBe(400);
    const accepted = await upload(app); expect(accepted.status).toBe(202); await finished(app, accepted.body.id);
  });
  it('rejects an oversized upload and resumes after rejection', async () => {
    const app = appFor(); const oversized = await request(app).post('/api/evaluations').attach('questionPaper', Buffer.alloc(100001), 'large.pdf');
    expect(oversized.status).toBe(400); expect(oversized.body.error.code).toBe('LIMIT_FILE_SIZE');
    const response = await upload(app); expect(response.status).toBe(202); await finished(app, response.body.id);
  });
  it('allows only one active evaluation and prevents deletion while active', async () => {
    let resolve!: (value: { value: unknown; usage: typeof usage }) => void;
    const model = fakeModel(); model.extract = () => new Promise(r => { resolve = r; });
    const app = appFor(model); const first = await upload(app);
    expect((await upload(app)).status).toBe(409); expect((await request(app).delete(`/api/evaluations/${first.body.id}`)).status).toBe(409);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    resolve({ value: examFixture(), usage }); await finished(app, first.body.id);
  });
  it.each(['MODEL_TIMEOUT', 'MODEL_REFUSAL', 'MODEL_INCOMPLETE', 'MODEL_UNAVAILABLE'])('reports %s with the failed stage and releases the slot', async code => {
    const model = fakeModel(); model.transcribe = async () => { throw new AppError(code, 'Safe failure message'); };
    const app = appFor(model); const response = await upload(app); const run = await finished(app, response.body.id);
    expect(run.stage).toBe('failed'); expect(run.error).toEqual({ code, message: 'Safe failure message', stage: 'transcribing' });
    expect(run.exam).not.toBeNull(); expect(run.totals).toBeNull();
    const second = await upload(app); expect(second.status).toBe(202); await finished(app, second.body.id);
  });
  it('expires files and results one hour after completion', async () => {
    const app = appFor(); const response = await upload(app); const run = await finished(app, response.body.id);
    await store.cleanup(run.finishedAt + 3599999); expect(store.get(run.id)).toBeDefined();
    await store.cleanup(run.finishedAt + 3600000); expect(store.get(run.id)).toBeUndefined(); await expect(access(path.join(root, run.id))).rejects.toThrow();
  });
  it('explains missing configuration and rejects external-origin writes', async () => {
    expect((await request(appFor(undefined, false)).get('/api/health')).body.configured).toBe(false);
    expect((await upload(appFor(undefined, false))).status).toBe(503);
    expect((await request(appFor()).post('/api/evaluations').set('Origin', 'https://example.com')).status).toBe(403);
  });
});

