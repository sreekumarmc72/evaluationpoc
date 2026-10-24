import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { mkdtemp, rm, access, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { ExamCatalog } from './exam-catalog.js';
import { RunStore } from './store.js';
import type { EvaluationModel } from './model.js';
import { examFixture, optionalExamFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';
import { directResolution } from './validation.js';
import { AppError } from './errors.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
function specification() { const exam = examFixture(); for (const q of exam.questions) q.rubric = [{ id: 'answer', description: 'Answer', maximumMarks: q.maximumMarks, expectedEvidence: q.expectedAnswer, keyAlignment: 'Provided answer', allocationBasis: 'inferred' }]; return exam; }
const fakeModel = (): EvaluationModel => ({
  extract: vi.fn(async () => ({ value: specification(), usage })),
  transcribe: vi.fn(async () => ({ value: transcriptionFixture(), usage })),
  resolve: vi.fn(async (_sheet, _questions, t) => ({ value: directResolution(t, specification()), usage })),
  grade: vi.fn(async () => ({ value: { ...gradingFixture(), results: gradingFixture().results.map(result => ({ ...result, criterionAwards: [{ criterionId: 'answer', marks: result.marks, evidence: 'Correct observed answer', reason: 'Matches key', sourceEntryIds: [result.identifier === '1' ? 'entry-1' : 'entry-2'] }] })) }, usage })),
});
let root: string; let store: RunStore; let catalog: ExamCatalog; let pdf: Buffer;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'catalog-api-test-')); store = new RunStore(path.join(root, 'runs'), 3600000, path.join(root, 'submissions')); await store.initialize(); catalog = new ExamCatalog(path.join(root, 'exams')); await catalog.initialize(); const doc = await PDFDocument.create(); doc.addPage(); pdf = Buffer.from(await doc.save()); });
afterEach(async () => { await store.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const appFor = (model = fakeModel()) => createApp({ store, examCatalog: catalog, model, models: { 'gpt-6.1-sol': model, 'sol-ultrafast': model }, modelId: 'gpt-6.1-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
function create(app: ReturnType<typeof appFor>, name = 'Accounting') { return request(app).post('/api/exams').field('name', name).attach('questionPaper', pdf, 'paper.pdf').attach('answerKey', pdf, 'key.pdf'); }
async function prepared(app: ReturnType<typeof appFor>, id: string) { for (let i = 0; i < 100; i++) { const value = (await request(app).get(`/api/exams/${id}`)).body; if (value.metadata.status !== 'preparing') return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Preparation did not finish'); }
async function finished(app: ReturnType<typeof appFor>, id: string) { for (let i = 0; i < 100; i++) { const value = (await request(app).get(`/api/evaluations/${id}`)).body; if (['completed', 'failed'].includes(value.stage)) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Evaluation did not finish'); }
describe('Faculty and student exam API', () => {
  it('keeps private task checkpoints and known usage across restart without adding them to public reports', async () => {
    const model = fakeModel(); let app = appFor(model); const created = await create(app); await prepared(app, created.body.id);
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf'); await finished(app, submitted.body.id);
    const key = 'a'.repeat(64); const record = { clientRequestId: 'client-local', responseId: 'resp-local', outcome: 'received', response: { output_text: 'private response', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } };
    await store.saveModelTask(submitted.body.id, key, record);
    await store.dispose(); store = new RunStore(path.join(root, 'restart'), 3600000, path.join(root, 'submissions')); await store.initialize(); app = appFor(model);
    expect(await store.readModelTask(submitted.body.id, key)).toEqual(record);
    expect(await store.knownModelUsage(submitted.body.id)).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(JSON.stringify((await request(app).get(`/api/evaluations/${submitted.body.id}`)).body)).not.toContain('private response');
    expect((await request(app).get(`/api/evaluations/${submitted.body.id}/task-${key}.json`)).status).toBe(404);
  });
  it('requires confirmation and resumes a failed submission using its original saved model', async () => {
    const model = fakeModel(); const app = appFor(model); const created = await create(app); await prepared(app, created.body.id);
    vi.mocked(model.grade).mockRejectedValueOnce(new AppError('MODEL_TIMEOUT', 'Timed out', 504));
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf');
    const failed = await finished(app, submitted.body.id); expect(failed.stage).toBe('failed'); expect(failed.recoveryAvailable).toBe(true);
    const endpoint = `/api/exams/${created.body.id}/submissions/${submitted.body.id}/retry`;
    expect((await request(app).post(endpoint).send({})).status).toBe(400);
    await catalog.updateModel(created.body.id, 'sol-ultrafast');
    const retry = await request(app).post(endpoint).send({ acknowledgeUnknownOutcome: true });
    expect(retry.status).toBe(202); expect(retry.body.model).toBe('gpt-6.1-sol');
    expect((await finished(app, submitted.body.id)).stage).toBe('completed');
    expect((await request(app).post(endpoint).send({ acknowledgeUnknownOutcome: true })).status).toBe(409);
    expect((await request(app).get(`/api/exams/${created.body.id}/submissions`)).body.total).toBe(1);
  });
  it('prepares all optional rubrics, evaluates sheet-only selections out of 50 and retains that denominator after review and restart', async () => {
    const model = fakeModel(); const optional = optionalExamFixture();
    vi.mocked(model.extract).mockResolvedValue({ value: optional, usage });
    const t = transcriptionFixture(); t.answers = ['1', '2', '4', '5'].map((identifier, index) => ({ ...t.answers[0], entryId: `entry-${index + 1}`, identifier }));
    vi.mocked(model.transcribe).mockResolvedValue({ value: t, usage });
    vi.mocked(model.grade).mockResolvedValue({ value: { results: optional.questions.map(q => {
      const source = t.answers.find(a => a.identifier === q.identifier); const marks = source ? q.maximumMarks : 0;
      return { identifier: q.identifier, maximumMarks: q.maximumMarks, marks, status: source ? 'graded' : 'unattempted', justification: 'Observed answer', correctPoints: [], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: [], criterionAwards: [{ criterionId: 'answer', marks, evidence: source ? 'Observed answer' : '', reason: 'Key comparison', sourceEntryIds: source ? [source.entryId] : [] }] };
    }), warnings: [] }, usage });
    const app = appFor(model); const created = await create(app, 'Cost accounting'); const preparedExam = await prepared(app, created.body.id);
    expect(preparedExam.metadata).toMatchObject({ status: 'ready', questionCount: 6, requiredQuestionCount: 4, maximumMarks: 50 });
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'optional-sheet.pdf');
    const run = await finished(app, submitted.body.id); expect(run.totals).toMatchObject({ totalMarks: 50, maximumMarks: 50 });
    expect(run.results.find((r: { identifier: string }) => r.identifier === '3').selectionStatus).toBe('not_selected');
    const review = await request(app).patch(`/api/evaluations/${run.id}/questions/1`).send({ marks: 8, reason: 'Reviewed method' });
    expect(review.body.totals).toMatchObject({ totalMarks: 48, maximumMarks: 50 });
    await store.dispose(); store = new RunStore(path.join(root, 'optional-restart-runs'), 3600000, path.join(root, 'submissions')); await store.initialize();
    const reopened = new ExamCatalog(path.join(root, 'exams')); await reopened.initialize();
    expect(reopened.get(created.body.id).metadata.maximumMarks).toBe(50);
    expect(store.get(run.id)?.totals?.totalMarks).toBe(48);
    expect(store.list(created.body.id)[0].totals?.maximumMarks).toBe(50);
  });
  it('saves a manual name without changing scan identity, grading bytes or PDFs, and reloads it after restart', async () => {
    const app = appFor(); const created = await create(app); await prepared(app, created.body.id);
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf');
    const original = await finished(app, submitted.body.id);
    const filename = path.join(root, 'submissions', created.body.id, submitted.body.id, 'evaluation.json');
    const bytes = await readFile(filename);
    const saved = await request(app).patch(`/api/evaluations/${submitted.body.id}/student-name`).send({ name: '  Anu Thomas  ' });
    expect(saved.status).toBe(200); expect(saved.body.manualStudentName.name).toBe('Anu Thomas');
    expect(saved.body.transcription).toEqual(original.transcription);
    expect(saved.body.results).toEqual(original.results); expect(saved.body.totals).toEqual(original.totals);
    expect(await readFile(filename)).toEqual(bytes); expect(await store.read(submitted.body.id, 'answerSheet')).toEqual(pdf);
    const history = await request(app).get(`/api/exams/${created.body.id}/submissions?search=Anu`);
    expect(history.body.total).toBe(1); expect(history.body.submissions[0]).toMatchObject({ studentName: 'Anu Thomas', nameSource: 'manual', nameStatus: 'absent' });
    for (const body of [{ name: '' }, { name: 'x'.repeat(161) }, { name: 'Anu', marks: 25 }]) expect((await request(app).patch(`/api/evaluations/${submitted.body.id}/student-name`).send(body)).status).toBe(400);
    await store.dispose(); store = new RunStore(path.join(root, 'name-restart-runs'), 3600000, path.join(root, 'submissions')); await store.initialize();
    expect(store.get(submitted.body.id)?.manualStudentName?.name).toBe('Anu Thomas');
    expect(store.get(submitted.body.id)?.totals).toEqual(original.totals);
  });
  it('restricts manual names to the owning session or faculty and refuses readable scan names', async () => {
    const model = fakeModel(); const open = appFor(model); const created = await create(open); await prepared(open, created.body.id);
    const password = 'test-name-password';
    const app = createApp({ store, examCatalog: catalog, model, models: { 'gpt-6.1-sol': model }, modelId: 'gpt-6.1-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000, facultyPassword: password, requireFacultyAuth: true });
    const facultyLogin = await request(app).post('/api/faculty/login').send({ username: 'faculty', password });
    expect(facultyLogin.status).toBe(200); const facultyCookie = facultyLogin.headers['set-cookie'][0].split(';')[0];
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf'); await finished(open, submitted.body.id);
    const cookie = submitted.headers['set-cookie'][0].split(';')[0]; const url = `/api/evaluations/${submitted.body.id}/student-name`;
    expect((await request(app).patch(url).send({ name: 'Anu' })).status).toBe(401);
    expect((await request(app).patch(url).set('Cookie', 'submission_access=wrong').send({ name: 'Anu' })).status).toBe(401);
    expect((await request(app).patch(url).set('Cookie', cookie).send({ name: 'Anu' })).status).toBe(200);
    expect((await request(app).patch(`/api/evaluations/${submitted.body.id}/questions/1`).set('Cookie', cookie).send({ marks: 2, reason: 'Override' })).status).toBe(401);
    expect((await request(app).patch(url).set('Cookie', facultyCookie).send({ name: 'Anu Thomas' })).status).toBe(200);
    const identity = transcriptionFixture(); identity.studentIdentity = { name: 'Readable Student', status: 'readable', sourcePages: [1], note: 'Name field' };
    vi.mocked(model.transcribe).mockResolvedValueOnce({ value: identity, usage });
    const named = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'named.pdf'); await finished(open, named.body.id);
    expect((await request(app).patch(`/api/evaluations/${named.body.id}/student-name`).set('Cookie', cookie).send({ name: 'Wrong session' })).status).toBe(401);
    expect((await request(app).patch(`/api/evaluations/${named.body.id}/student-name`).set('Cookie', facultyCookie).send({ name: 'Replacement' })).status).toBe(409);
    const active = await store.create({ answerSheet: pdf }, 'gpt-6.1-sol', { examId: created.body.id, examVersion: 1, exam: specification() });
    expect((await request(app).patch(`/api/evaluations/${active.id}/student-name`).set('Cookie', facultyCookie).send({ name: 'Too early' })).status).toBe(409);
  });
  it('persists a title edit without changing the exam ID, rubric, model or documents', async () => {
    const model = fakeModel(); const app = appFor(model); const created = await create(app); const before = await prepared(app, created.body.id);
    const edited = await request(app).patch(`/api/exams/${created.body.id}`).send({ name: '  Revised Accounting  ' });
    expect(edited.status).toBe(200);
    expect(edited.body.metadata).toEqual({ ...before.metadata, name: 'Revised Accounting' });
    expect((await request(app).get(`/api/exams/${created.body.id}/student`)).body.metadata.name).toBe('Revised Accounting');
    expect(catalog.get(created.body.id).specification).toEqual(before.specification);
    const reopened = new ExamCatalog(path.join(root, 'exams')); await reopened.initialize();
    expect(reopened.get(created.body.id).metadata.name).toBe('Revised Accounting');
    expect(await reopened.read(created.body.id, 'questionPaper')).toEqual(pdf);
    expect(model.extract).toHaveBeenCalledTimes(1);
    for (const body of [{ name: '' }, { name: 'x'.repeat(121) }, { name: 'Valid', model: 'sol-ultrafast' }]) expect((await request(app).patch(`/api/exams/${created.body.id}`).send(body)).status).toBe(400);
  });
  it('requires exact current confirmation and archives only the selected exam while retaining submissions', async () => {
    const app = appFor(); const created = await create(app); const before = await prepared(app, created.body.id);
    const other = await create(app, 'Other exam'); await prepared(app, other.body.id);
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf'); await finished(app, submitted.body.id);
    const url = `/api/exams/${created.body.id}`;
    expect((await request(app).delete(url)).status).toBe(400);
    expect((await request(app).delete(url).send({ confirmationId: other.body.id, confirmationName: before.metadata.name, acknowledged: true })).status).toBe(409);
    expect((await request(app).delete(url).send({ confirmationId: created.body.id, confirmationName: 'Wrong title', acknowledged: true })).status).toBe(409);
    store.reserve();
    expect((await request(app).delete(url).send({ confirmationId: created.body.id, confirmationName: before.metadata.name, acknowledged: true })).status).toBe(409);
    expect((await request(app).patch(url).send({ name: 'Busy edit' })).status).toBe(409);
    store.release();
    expect((await request(app).delete(url).send({ confirmationId: created.body.id, confirmationName: before.metadata.name, acknowledged: true })).status).toBe(204);
    expect((await request(app).get(`${url}/student`)).status).toBe(404);
    expect((await request(app).post(`${url}/evaluations`).attach('answerSheet', pdf, 'new.pdf')).status).toBe(404);
    expect((await request(app).get('/api/exams')).body.exams.map((item: { id: string }) => item.id)).toEqual([other.body.id]);
    expect(await readFile(path.join(root, 'exams', '.deleted', created.body.id, 'questionPaper.pdf'))).toEqual(pdf);
    expect(await store.read(submitted.body.id, 'answerSheet')).toEqual(pdf);
    const reopened = new ExamCatalog(path.join(root, 'exams')); await reopened.initialize();
    expect(() => reopened.get(created.body.id)).toThrow(/not found/);
    expect(reopened.get(other.body.id).metadata.name).toBe('Other exam');
    await store.dispose(); store = new RunStore(path.join(root, 'restarted-runs'), 3600000, path.join(root, 'submissions')); await store.initialize();
    expect(store.get(submitted.body.id)?.stage).toBe('completed');
    expect(await store.read(submitted.body.id, 'answerSheet')).toEqual(pdf);
  });
  it('keeps reports and PDFs through cleanup, start-over and restart without changing existing exams', async () => {
    const model = fakeModel(); const app = appFor(model); const created = await create(app); const before = await prepared(app, created.body.id);
    const named = transcriptionFixture(); named.studentIdentity = { name: 'Anu Thomas', status: 'readable', sourcePages: [1], note: 'Labelled Name field on page 1.' };
    vi.mocked(model.transcribe).mockResolvedValueOnce({ value: named, usage });
    const submissions: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf');
      expect(response.status).toBe(202); submissions.push(response.body.id);
      expect((await finished(app, response.body.id)).durable).toBe(true);
      await request(app).delete(`/api/evaluations/${response.body.id}`);
    }
    await store.cleanup(Date.now() + 7200000);
    expect((await request(app).get(`/api/exams/${created.body.id}/submissions`)).body.total).toBe(2);
    const filtered = await request(app).get(`/api/exams/${created.body.id}/submissions?search=Anu`);
    expect(filtered.body.submissions[0].studentName).toBe('Anu Thomas');
    expect((await request(app).get('/api/exams')).body.exams[0].submissionCount).toBe(2);
    await store.dispose(); store = new RunStore(path.join(root, 'restarted-runs'), 3600000, path.join(root, 'submissions')); await store.initialize();
    const restarted = appFor(model);
    for (const id of submissions) { expect((await request(restarted).get(`/api/evaluations/${id}`)).body.stage).toBe('completed'); expect(await store.read(id, 'answerSheet')).toEqual(pdf); }
    expect(catalog.get(created.body.id)).toEqual(before);
    const json = await readFile(path.join(root, 'submissions', created.body.id, submissions[0], 'evaluation.json'), 'utf8');
    expect(json).not.toContain('tokenHash'); expect(json).not.toContain('accessToken');
  });
  it('protects faculty history and PDFs while allowing each student only their own submission cookie', async () => {
    const model = fakeModel(); const openApp = appFor(model); const created = await create(openApp); await prepared(openApp, created.body.id);
    const password = 'test-faculty-password';
    const app = createApp({ store, examCatalog: catalog, model, models: { 'gpt-6.1-sol': model }, modelId: 'gpt-6.1-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000, facultyPassword: password, requireFacultyAuth: true });
    const facultyLogin = await request(app).post('/api/faculty/login').send({ username: 'faculty', password });
    expect(facultyLogin.status).toBe(200); const facultyCookie = facultyLogin.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).get('/faculty')).status).toBe(302);
    expect((await request(app).get('/api/exams')).status).toBe(401);
    expect((await request(app).patch(`/api/exams/${created.body.id}`).send({ name: 'Unauthorised' })).status).toBe(401);
    expect((await request(app).delete(`/api/exams/${created.body.id}`).send({ confirmationId: created.body.id, confirmationName: 'Accounting', acknowledged: true })).status).toBe(401);
    expect((await request(app).get('/API/EXAMS')).status).toBe(401);
    expect((await request(app).get('/Faculty')).status).toBe(302);
    expect((await request(app).get(`/api/exams/${created.body.id}/student`)).status).toBe(200);
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf');
    expect(submitted.status).toBe(202); await finished(openApp, submitted.body.id);
    const cookie = submitted.headers['set-cookie'][0].split(';')[0];
    expect(submitted.headers['set-cookie'][0]).toContain('HttpOnly'); expect(submitted.headers['set-cookie'][0]).toContain('SameSite=Strict');
    const runUrl = `/api/evaluations/${submitted.body.id}`;
    expect((await request(app).post(`/api/exams/${created.body.id}/submissions/${submitted.body.id}/retry`).set('Cookie', cookie).send({ acknowledgeUnknownOutcome: true })).status).toBe(401);
    expect((await request(app).get(runUrl)).status).toBe(401);
    expect((await request(app).get(`${runUrl}/answer-sheet`)).status).toBe(401);
    expect((await request(app).get(runUrl).set('Cookie', cookie)).body.stage).toBe('completed');
    expect((await request(app).get(`${runUrl}/answer-sheet`).set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).patch(`${runUrl}/questions/1`).set('Cookie', cookie).send({ marks: 1, reason: 'Student override' })).status).toBe(401);
    expect((await request(app).get(`/api/exams/${created.body.id}/submissions`)).status).toBe(401);
    expect((await request(app).get(`/api/exams/${created.body.id}/submissions`).set('Cookie', facultyCookie)).body.total).toBe(1);
    const second = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'second.pdf'); await finished(openApp, second.body.id);
    expect((await request(app).get(`/api/evaluations/${second.body.id}`).set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).get('/api/storage')).status).toBe(401);
    expect((await request(app).get('/api/storage').set('Cookie', facultyCookie)).body.storage.availableBytes).toBeGreaterThan(0);
  });
  it('retains interrupted submissions and their PDF without restarting model calls', async () => {
    const created = await create(appFor()); await prepared(appFor(), created.body.id);
    const run = await store.create({ answerSheet: pdf }, 'gpt-6.1-sol', { examId: created.body.id, examVersion: 1, exam: specification() });
    const token = store.takeAccessToken(run.id)!; run.stage = 'transcribing'; await store.checkpoint(run); await store.dispose();
    store = new RunStore(path.join(root, 'new-runs'), 3600000, path.join(root, 'submissions')); await store.initialize();
    expect(store.get(run.id)?.error?.code).toBe('PROCESSING_INTERRUPTED'); expect(store.get(run.id)?.stage).toBe('failed');
    expect(store.hasAccess(run.id, token)).toBe(true); expect(await store.read(run.id, 'answerSheet')).toEqual(pdf);
  });
  it('preserves damaged archive files and reports them to the faculty instead of deleting them', async () => {
    const app = appFor(); const created = await create(app); await prepared(app, created.body.id);
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf'); await finished(app, submitted.body.id);
    const filename = path.join(root, 'submissions', created.body.id, submitted.body.id, 'evaluation.json');
    await writeFile(filename, 'damaged-json'); await store.dispose();
    store = new RunStore(path.join(root, 'new-runs'), 3600000, path.join(root, 'submissions')); await store.initialize();
    expect((await store.storageUsage())?.unreadableRecords).toEqual([{ examId: created.body.id, submissionId: submitted.body.id }]);
    expect(await readFile(filename, 'utf8')).toBe('damaged-json');
    await expect(access(path.join(root, 'submissions', created.body.id, submitted.body.id, 'answerSheet.pdf'))).resolves.toBeUndefined();
  });
  it('stops before billing on initial storage failure and never publishes unsaved completed results', async () => {
    const model = fakeModel(); const app = appFor(model); const created = await create(app); await prepared(app, created.body.id);
    const original = store.checkpoint.bind(store);
    const checkpoint = vi.spyOn(store, 'checkpoint').mockRejectedValueOnce(new AppError('STORAGE_FAILURE', 'Disk full', 507));
    expect((await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf')).status).toBe(507);
    expect(model.transcribe).not.toHaveBeenCalled();
    checkpoint.mockImplementation(async run => { if (run.stage === 'completed') throw new AppError('STORAGE_FAILURE', 'Disk full', 507); await original(run); });
    const accepted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf');
    const failed = await finished(app, accepted.body.id); expect(failed.stage).toBe('failed'); expect(failed.error.code).toBe('STORAGE_FAILURE');
    const disk = JSON.parse(await readFile(path.join(root, 'submissions', created.body.id, accepted.body.id, 'evaluation.json'), 'utf8'));
    expect(disk.stage).toBe('failed'); checkpoint.mockRestore();
  });
  it('persists model edits and uses the latest saved model for future submissions without rebuilding the rubric', async () => {
    const standard = fakeModel(); const ultra = fakeModel();
    const app = createApp({ store, examCatalog: catalog, model: standard, models: { 'gpt-6.1-sol': standard, 'sol-ultrafast': ultra }, modelId: 'gpt-6.1-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
    const created = await create(app); const original = await prepared(app, created.body.id);
    // A student may have opened this metadata before the faculty saves a change.
    expect((await request(app).get(`/api/exams/${created.body.id}/student`)).body.metadata.model).toBe('gpt-6.1-sol');
    const changed = await request(app).patch(`/api/exams/${created.body.id}/model`).send({ model: 'sol-ultrafast' });
    expect(changed.status).toBe(200); expect(changed.body.metadata).toMatchObject({ model: 'sol-ultrafast', preparationModel: 'gpt-6.1-sol', version: 1 });
    expect((await request(app).get(`/api/exams/${created.body.id}`)).body.specification).toEqual(original.specification);
    const reopened = new ExamCatalog(path.join(root, 'exams')); await reopened.initialize();
    expect(reopened.get(created.body.id).metadata.model).toBe('sol-ultrafast');
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf');
    expect(submitted.status).toBe(202); expect((await finished(app, submitted.body.id)).model).toBe('sol-ultrafast');
    expect(ultra.transcribe).toHaveBeenCalledOnce(); expect(standard.transcribe).not.toHaveBeenCalled();
    expect(standard.extract).toHaveBeenCalledOnce(); expect(ultra.extract).not.toHaveBeenCalled();
    expect((await request(app).patch(`/api/exams/${created.body.id}/model`).send({ model: 'gpt-6.1-sol' })).status).toBe(200);
    expect(catalog.get(created.body.id).metadata.preparationModel).toBe('gpt-6.1-sol');
  });
  it('rejects invalid model edits, busy updates and edits to exams still preparing', async () => {
    const app = appFor(); const created = await create(app); await prepared(app, created.body.id);
    const url = `/api/exams/${created.body.id}/model`;
    for (const body of [{}, { model: 'gpt-6-luna' }, { model: 'sol-ultrafast', name: 'changed' }]) expect((await request(app).patch(url).send(body)).status).toBe(400);
    store.reserve(); expect((await request(app).patch(url).send({ model: 'sol-ultrafast' })).status).toBe(409); store.release();
    const pending = await catalog.create('Preparing exam', 'gpt-6.1-sol', { questionPaper: { name: 'paper.pdf', pages: 1, buffer: pdf }, answerKey: { name: 'key.pdf', pages: 1, buffer: pdf } });
    expect((await request(app).patch(`/api/exams/${pending.id}/model`).send({ model: 'sol-ultrafast' })).status).toBe(409);
    expect((await request(app).patch('/api/exams/not-an-id/model').send({ model: 'sol-ultrafast' })).status).toBe(404);
    expect(catalog.get(created.body.id).metadata.model).toBe('gpt-6.1-sol');
  });
  it.each(['gpt-6.1-sol', 'sol-ultrafast'])('enforces the faculty model %s and returns student metadata without the key', async tier => {
    const standard = fakeModel(); const ultra = fakeModel();
    const app = createApp({ store, examCatalog: catalog, model: standard, models: { 'gpt-6.1-sol': standard, 'sol-ultrafast': ultra }, modelId: 'gpt-6.1-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
    const created = await request(app).post('/api/exams').field('name', 'Faculty model').field('model', tier).attach('questionPaper', pdf, 'paper.pdf').attach('answerKey', pdf, 'key.pdf');
    await prepared(app, created.body.id);
    const student = await request(app).get(`/api/exams/${created.body.id}/student`);
    expect(student.status).toBe(200); expect(student.body.metadata).toMatchObject({ id: created.body.id, model: tier, questionCount: 2, maximumMarks: 5 });
    expect(student.body).not.toHaveProperty('specification');
    for (const override of ['gpt-6.1-sol', 'sol-ultrafast']) {
      const rejected = await request(app).post(`/api/exams/${created.body.id}/evaluations`).field('model', override).attach('answerSheet', pdf, 'sheet.pdf');
      expect(rejected.status).toBe(400); expect(rejected.body.error.code).toBe('INVALID_SUBMISSION');
    }
    const submitted = await request(app).post(`/api/exams/${created.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf');
    expect(submitted.status).toBe(202); expect((await finished(app, submitted.body.id)).model).toBe(tier);
    expect((tier === 'sol-ultrafast' ? ultra : standard).transcribe).toHaveBeenCalledOnce();
    expect((tier === 'sol-ultrafast' ? standard : ultra).transcribe).not.toHaveBeenCalled();
    expect((await request(app).get('/api/exams/not-an-id/student')).status).toBe(404);
  });
  it('prepares multiple named exams once and evaluates each new sheet without any extraction call', async () => {
    const model = fakeModel(); const app = appFor(model);
    const first = await create(app, 'Accounting A'); expect(first.status).toBe(202); expect((await prepared(app, first.body.id)).metadata.status).toBe('ready');
    const second = await create(app, 'Accounting B'); await prepared(app, second.body.id);
    expect((await request(app).get('/api/exams')).body.exams).toHaveLength(2); expect(model.extract).toHaveBeenCalledTimes(2);
    for (let attempt = 0; attempt < 2; attempt++) {
      const submission = await request(app).post(`/api/exams/${first.body.id}/evaluations`).attach('answerSheet', pdf, 'student.pdf'); expect(submission.status).toBe(202);
      const result = await finished(app, submission.body.id); expect(result.stage).toBe('completed'); expect(result.examId).toBe(first.body.id); expect(result.examVersion).toBe(1); expect(result.examReused).toBe(true); expect(result.totals.totalMarks).toBe(5);
      expect(result.stageDurations).not.toHaveProperty('extracting_exam'); expect(result.usage.totalTokens).toBe(30); expect(result.exam).toEqual(specification());
      await expect(access(path.join(root, 'runs', result.id, 'questionPaper.pdf'))).rejects.toThrow();
      expect((await request(app).get(`/api/evaluations/${result.id}/answer-sheet`)).status).toBe(200);
    }
    expect(model.extract).toHaveBeenCalledTimes(2); expect(model.transcribe).toHaveBeenCalledTimes(2); expect(model.grade).toHaveBeenCalledTimes(2);
    const reopened = new ExamCatalog(path.join(root, 'exams')); await reopened.initialize(); expect(reopened.list()).toHaveLength(2); expect(reopened.get(first.body.id).specification).toEqual(specification());
  });
  it('persists failed preparations, rejects their submissions and allows explicit retry', async () => {
    const model = fakeModel(); vi.mocked(model.extract).mockRejectedValueOnce(new AppError('MODEL_REFUSAL', 'Preparation refused'));
    const app = appFor(model); const response = await create(app); const failed = await prepared(app, response.body.id);
    expect(failed.metadata.status).toBe('failed'); expect(failed.metadata.error.code).toBe('MODEL_REFUSAL');
    expect((await request(app).post(`/api/exams/${response.body.id}/evaluations`).attach('answerSheet', pdf, 'sheet.pdf')).status).toBe(409);
    expect((await request(app).post(`/api/exams/${response.body.id}/prepare`)).status).toBe(202);
    expect((await prepared(app, response.body.id)).metadata.status).toBe('ready');
    expect((await request(app).post(`/api/exams/${response.body.id}/prepare`)).status).toBe(409);
  });
  it('shares the single active operation limit and validates upload fields before creating an exam', async () => {
    const app = appFor(); store.reserve(); expect((await create(app)).status).toBe(409); store.release();
    expect((await create(app, '  ')).status).toBe(400);
    expect((await request(app).post('/api/exams').field('name', 'Exam').attach('questionPaper', pdf, 'paper.pdf')).status).toBe(400);
    expect((await request(app).post('/api/exams').field('name', 'Exam').field('model', 'gpt-6-luna').attach('questionPaper', pdf, 'paper.pdf').attach('answerKey', pdf, 'key.pdf')).status).toBe(400);
    expect((await request(app).post('/api/exams').field('name', 'Exam').attach('questionPaper', Buffer.from('invalid'), 'paper.pdf').attach('answerKey', pdf, 'key.pdf')).status).toBe(400);
    expect(catalog.list()).toHaveLength(0);
    const exam = await create(app); await prepared(app, exam.body.id);
    expect((await request(app).post(`/api/exams/${exam.body.id}/evaluations`).attach('questionPaper', pdf, 'paper.pdf').attach('answerSheet', pdf, 'sheet.pdf')).status).toBe(400);
    expect((await request(app).post(`/api/exams/${exam.body.id}/evaluations`).field('model', 'gpt-6-luna').attach('answerSheet', pdf, 'sheet.pdf')).status).toBe(400);
    expect((await request(app).get('/api/exams/not-an-id')).status).toBe(404);
  });
  it('marks interrupted preparation failed on restart and prevents an unvalidated exam from becoming ready', async () => {
    const metadata = await catalog.create('Interrupted', 'gpt-6.1-sol', { questionPaper: { name: 'paper.pdf', pages: 1, buffer: pdf }, answerKey: { name: 'key.pdf', pages: 1, buffer: pdf } });
    const reopened = new ExamCatalog(path.join(root, 'exams')); await reopened.initialize();
    expect(reopened.get(metadata.id).metadata).toMatchObject({ status: 'failed', error: { code: 'PREPARATION_INTERRUPTED' } });
    const model = fakeModel(); vi.mocked(model.extract).mockResolvedValueOnce({ value: examFixture(), usage });
    const app = appFor(model); const response = await create(app); expect((await prepared(app, response.body.id)).metadata.status).toBe('failed');
  });
  it('does not expose damaged saved specifications as ready exams after restart', async () => {
    const app = appFor(); const response = await create(app); await prepared(app, response.body.id);
    await writeFile(path.join(root, 'exams', response.body.id, 'specification.json'), JSON.stringify(examFixture()));
    const reopened = new ExamCatalog(path.join(root, 'exams')); await reopened.initialize();
    expect(reopened.get(response.body.id)).toMatchObject({ metadata: { status: 'failed', error: { code: 'INVALID_SAVED_EXAM' } }, specification: null });
  });
});
