import type { Express } from 'express';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ExamCatalog } from './exam-catalog.js';
import type { RunStore } from './store.js';
import type { EvaluationModel } from './model.js';
import { AppError, publicError } from './errors.js';
import { validatePdf } from './pdf.js';
import { validateExam } from './validation.js';
import { processRun } from './pipeline.js';

type Options = { examCatalog: ExamCatalog; store: RunStore; models?: Record<string, EvaluationModel>; configured: boolean; maxBytes: number; maxPages: number; appOrigin?: string };
const tierSchema = z.enum(['gpt-6.1-sol', 'sol-ultrafast']);
export function registerExamRoutes(app: Express, options: Options) {
  const { examCatalog: catalog, store } = options;
  const preparationUpload = multer({ storage: multer.memoryStorage(), limits: { files: 2, fields: 2, parts: 4, fileSize: options.maxBytes, fieldSize: 1000 } }).fields([{ name: 'questionPaper', maxCount: 1 }, { name: 'answerKey', maxCount: 1 }]);
  const submissionUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fields: 1, parts: 2, fileSize: options.maxBytes, fieldSize: 100 } }).single('answerSheet');
  const selectModel = (id: string) => { if (!options.configured) throw new AppError('NOT_CONFIGURED', 'Configure the backend API key and model before processing exams.', 503); const model = options.models?.[id]; if (!model) throw new AppError('INVALID_MODEL', 'The selected Sol processing option is not configured.', 400); return model; };
  const prepare = async (id: string, model: EvaluationModel) => {
    const start = Date.now();
    try {
      const entry = catalog.get(id);
      const files = await Promise.all((['questionPaper', 'answerKey'] as const).map(async field => {
        const buffer = await catalog.read(id, field); await validatePdf(buffer, field, options.maxBytes, options.maxPages);
        if (createHash('sha256').update(buffer).digest('hex') !== entry.metadata.documents[field].sha256) throw new AppError('CHANGED_EXAM_DOCUMENT', 'Saved exam documents changed unexpectedly. Create a new exam with the intended files.');
        return buffer;
      }));
      const response = await model.extract(files[0], files[1]); const exam = validateExam(response.value);
      if (exam.questions.some(q => !q.rubric?.length)) throw new AppError('INVALID_MODEL_RESULT', 'Every prepared question requires a validated marking rubric. Retry preparation.');
      await catalog.ready(id, exam, response.usage, Date.now() - start);
    } catch (error) { const safe = publicError(error); await catalog.failed(id, { code: safe.code, message: safe.message }, Date.now() - start); }
    finally { store.release(); console.info(JSON.stringify({ examId: id, status: catalog.get(id).metadata.status, durationMs: Date.now() - start })); }
  };
  app.get('/api/exams', (_req, res) => res.json({ exams: catalog.list().map(exam => ({ ...exam, submissionCount: store.list(exam.id).length })) }));
  app.get('/api/exams/:id/student', (req, res, next) => { try { res.json({ metadata: catalog.get(req.params.id).metadata }); } catch (error) { next(error); } });
  app.get('/api/exams/:id', (req, res, next) => { try { res.json(catalog.get(req.params.id)); } catch (error) { next(error); } });
  app.get('/api/exams/:id/submissions', (req, res, next) => { try {
    catalog.get(req.params.id);
    const all = store.list(req.params.id).filter(item => `${item.studentName ?? ''} ${item.id}`.toLowerCase().includes(String(req.query.search ?? '').toLowerCase().slice(0, 160)));
    const page = Math.max(0, Math.floor(Number(req.query.page) || 0));
    res.json({ submissions: all.slice(page * 50, (page + 1) * 50), total: all.length, page });
  } catch (error) { next(error); } });
  app.patch('/api/exams/:id', express.json({ limit: '2kb' }), (req, res, next) => {
    let reserved = false;
    void (async () => { try {
      const input = z.object({ name: z.string().trim().min(1).max(120) }).strict().safeParse(req.body);
      if (!input.success) throw new AppError('INVALID_EXAM', 'Enter an exam title of 1–120 characters.', 400);
      store.reserve(); reserved = true;
      res.json({ metadata: await catalog.updateName(req.params.id, input.data.name) });
    } catch (error) { next(error); } finally { if (reserved) store.release(); } })();
  });
  app.delete('/api/exams/:id', express.json({ limit: '2kb' }), (req, res, next) => {
    let reserved = false;
    void (async () => { try {
      const input = z.object({ confirmationId: z.string(), confirmationName: z.string(), acknowledged: z.literal(true) }).strict().safeParse(req.body);
      if (!input.success) throw new AppError('CONFIRMATION_REQUIRED', 'Confirm the exam ID, current title and deletion warning.', 400);
      store.reserve(); reserved = true;
      const entry = catalog.get(req.params.id);
      if (input.data.confirmationId !== entry.metadata.id || input.data.confirmationName !== entry.metadata.name) throw new AppError('CONFIRMATION_MISMATCH', 'Exam details changed or the title does not match. Refresh and confirm the current exam.', 409);
      await catalog.archive(req.params.id); res.status(204).end();
    } catch (error) { next(error); } finally { if (reserved) store.release(); } })();
  });
  app.patch('/api/exams/:id/model', express.json({ limit: '2kb' }), (req, res, next) => {
    let reserved = false;
    void (async () => { try {
      const input = z.object({ model: tierSchema }).strict().safeParse(req.body);
      if (!input.success) throw new AppError('INVALID_MODEL', 'Choose standard Sol or Sol Ultrafast processing.', 400);
      selectModel(input.data.model);
      store.reserve(); reserved = true;
      res.json({ metadata: await catalog.updateModel(req.params.id, input.data.model) });
    } catch (error) { next(error); } finally { if (reserved) store.release(); } })();
  });
  app.post('/api/exams', (req, res, next) => {
    try { if (!options.configured) throw new AppError('NOT_CONFIGURED', 'Configure the backend API key before preparing exams.', 503); store.reserve(); } catch (error) { return next(error); }
    preparationUpload(req, res, uploadError => { void (async () => {
      try {
        if (uploadError) throw uploadError;
        const input = z.object({ name: z.string().trim().min(1).max(120), model: tierSchema.default('gpt-6.1-sol') }).strict().safeParse(req.body);
        if (!input.success) throw new AppError('INVALID_EXAM', 'Enter an exam name (1–120 characters) and choose a Sol processing option.', 400);
        const model = selectModel(input.data.model); const files = req.files as Record<string, Express.Multer.File[]>;
        if (!files?.questionPaper?.[0] || !files?.answerKey?.[0]) throw new AppError('MISSING_FILES', 'Upload both the question paper and answer key PDF.', 400);
        const documents = {} as Record<'questionPaper' | 'answerKey', { name: string; pages: number; buffer: Buffer }>;
        for (const field of ['questionPaper', 'answerKey'] as const) { const file = files[field][0]; documents[field] = { name: file.originalname, buffer: file.buffer, pages: await validatePdf(file.buffer, field, options.maxBytes, options.maxPages) }; }
        const exam = await catalog.create(input.data.name, input.data.model, documents); res.status(202).json({ id: exam.id });
        void prepare(exam.id, model).catch(() => console.error('Exam preparation persistence failed.'));
      } catch (error) { store.release(); next(error); }
    })(); });
  });
  app.post('/api/exams/:id/prepare', (req, res, next) => {
    let reserved = false;
    void (async () => { try {
      const entry = catalog.get(req.params.id); const model = selectModel(entry.metadata.model); store.reserve(); reserved = true;
      await catalog.beginRetry(req.params.id); res.status(202).json({ id: req.params.id });
      void prepare(req.params.id, model).catch(() => console.error('Exam preparation persistence failed.'));
    } catch (error) { if (reserved) store.release(); next(error); } })();
  });
  app.post('/api/exams/:id/evaluations', (req, res, next) => {
    let entry: ReturnType<ExamCatalog['get']>;
    try { entry = catalog.get(req.params.id); if (entry.metadata.status !== 'ready' || !entry.specification) throw new AppError('EXAM_NOT_READY', 'This exam is not ready for submissions.', 409); if (!options.configured) throw new AppError('NOT_CONFIGURED', 'Configure the backend API key before evaluating.', 503); store.reserve(); } catch (error) { return next(error); }
    submissionUpload(req, res, uploadError => { void (async () => { try {
      if (uploadError) throw uploadError;
      const body = z.object({}).strict().safeParse(req.body);
      if (!body.success) throw new AppError('INVALID_SUBMISSION', 'Only the answer sheet is accepted. The faculty has already selected the processing model.', 400);
      const model = selectModel(entry.metadata.model); if (!req.file) throw new AppError('MISSING_FILES', 'Upload one answer-sheet PDF.', 400);
      const start = Date.now(); const pages = await validatePdf(req.file.buffer, 'answerSheet', options.maxBytes, options.maxPages);
      const run = await store.create({ answerSheet: req.file.buffer }, entry.metadata.model, { examId: entry.metadata.id, examVersion: entry.metadata.version, exam: entry.specification! });
      run.examId = entry.metadata.id; run.examVersion = entry.metadata.version; run.examReused = true; run.exam = entry.specification;
      run.stageDurations.validating = Date.now() - start; run.stageModels = model.stageModels ?? Object.fromEntries(['transcribing', 'resolving_answers', 'evaluating'].map(stage => [stage, 'gpt-6.1-sol']));
      const token = store.takeAccessToken(run.id);
      if (token) res.cookie('submission_access', token, { path: `/api/evaluations/${run.id}`, httpOnly: true, sameSite: 'strict', secure: req.secure || !!options.appOrigin?.startsWith('https://') || !!process.env.RENDER, maxAge: 30 * 86400000 });
      res.status(202).json({ id: run.id }); void processRun(run, store, model, pages, entry.specification!);
    } catch (error) { store.release(); next(error); } })(); });
  });
}
