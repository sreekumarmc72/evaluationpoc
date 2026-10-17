import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { ExamCatalog } from './exam-catalog.js';
import { RunStore } from './store.js';
import type { EvaluationModel } from './model.js';
import { examFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';
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
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'catalog-api-test-')); store = new RunStore(path.join(root, 'runs'), 3600000); catalog = new ExamCatalog(path.join(root, 'exams')); await catalog.initialize(); const doc = await PDFDocument.create(); doc.addPage(); pdf = Buffer.from(await doc.save()); });
afterEach(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }); });
const appFor = (model = fakeModel()) => createApp({ store, examCatalog: catalog, model, models: { 'gpt-6.1-sol': model, 'sol-ultrafast': model }, modelId: 'gpt-6.1-sol', configured: true, maxBytes: 100000, maxPages: 10, retentionMs: 3600000 });
function create(app: ReturnType<typeof appFor>, name = 'Accounting') { return request(app).post('/api/exams').field('name', name).attach('questionPaper', pdf, 'paper.pdf').attach('answerKey', pdf, 'key.pdf'); }
async function prepared(app: ReturnType<typeof appFor>, id: string) { for (let i = 0; i < 100; i++) { const value = (await request(app).get(`/api/exams/${id}`)).body; if (value.metadata.status !== 'preparing') return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Preparation did not finish'); }
async function finished(app: ReturnType<typeof appFor>, id: string) { for (let i = 0; i < 100; i++) { const value = (await request(app).get(`/api/evaluations/${id}`)).body; if (['completed', 'failed'].includes(value.stage)) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Evaluation did not finish'); }
describe('Faculty and student exam API', () => {
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
