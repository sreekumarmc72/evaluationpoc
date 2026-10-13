import express from 'express';
import multer from 'multer';
import { isTerminal, uploadFields, selectableModels, type UploadField } from '@poc/shared';
import type { EvaluationModel } from './model.js';
import type { RunStore } from './store.js';
import { AppError, publicError } from './errors.js';
import { validatePdf } from './pdf.js';
import { z } from 'zod';
import { calculateTotals } from './validation.js';
import { processRun } from './pipeline.js';
import { examFields, type RetainedExamStore } from './retained-exam.js';
import type { ExamCatalog } from './exam-catalog.js';
import { registerExamRoutes } from './exam-routes.js';

type Options = { store: RunStore; retainedExam?: RetainedExamStore; examCatalog?: ExamCatalog; model: EvaluationModel; modelId: string; models?: Record<string, EvaluationModel>; configured: boolean; maxBytes: number; maxPages: number; retentionMs: number };
export function createApp(options: Options) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Same-origin writes only. CLI clients without Origin remain supported.
  app.use((req, _res, next) => {
    const origin = req.get('origin');
    if (origin && !['GET', 'HEAD'].includes(req.method)) {
      try {
        const url = new URL(origin);
        if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return next(new AppError('ORIGIN_REJECTED', 'Only local application requests are accepted.', 403));
      } catch { return next(new AppError('ORIGIN_REJECTED', 'Invalid request origin.', 403)); }
    }
    next();
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: options.maxBytes, files: 3, fields: 1, fieldSize: 100, parts: 4 } }).fields(uploadFields.map(name => ({ name, maxCount: 1 })));
  app.get('/api/health', (_req, res, next) => {
    void (async () => { const saved = await options.retainedExam?.read(); res.json({ ok: true, configured: options.configured, model: options.modelId, models: selectableModels.filter(id => !!options.models?.[id]), limits: { maxFileBytes: options.maxBytes, maxPages: options.maxPages }, retentionMs: options.retentionMs, retainedExam: options.retainedExam?.metadata(saved ?? null) ?? null }); })().catch(next);
  });
  app.delete('/api/exam', (_req, res, next) => {
    try { options.store.reserve(); } catch (error) { return next(error); }
    void (async () => { try { await options.retainedExam?.clear(); for (const model of new Set([options.model, ...Object.values(options.models ?? {})])) model.clearExamCache?.(); res.status(204).end(); } finally { options.store.release(); } })().catch(next);
  });
  app.post('/api/evaluations', (req, res, next) => {
    if (!options.configured) return next(new AppError('NOT_CONFIGURED', 'Set OPENAI_API_KEY and OPENAI_MODEL in the backend .env, then restart.', 503));
    try { options.store.reserve(); } catch (error) { return next(error); }
    upload(req, res, uploadError => {
      void (async () => {
        try {
          if (uploadError) throw uploadError;
          if (Object.keys(req.body ?? {}).some(key => key !== 'model')) throw new AppError('INVALID_MODEL', 'Only the optional model field is accepted.', 400);
          const selectedModel = req.body?.model ?? options.modelId;
          if (typeof selectedModel !== 'string' || (req.body?.model !== undefined && !selectableModels.some(id => id === selectedModel))) throw new AppError('INVALID_MODEL', 'Choose an evaluation model offered in the model selector.', 400);
          const model = selectedModel === options.modelId ? options.model : options.models?.[selectedModel];
          if (!model) throw new AppError('INVALID_MODEL', 'The selected model is not configured on this backend.', 400);
          const input = req.files as Record<string, Express.Multer.File[]> | undefined;
          const saved = await options.retainedExam?.read();
          if (!input || input.answerSheet?.length !== 1 || examFields.some(field => input[field]?.length !== 1 && !saved?.[field])) throw new AppError('MISSING_FILES', 'Upload one question paper, one answer key and one answer sheet PDF. A saved exam can be reused with only a new answer sheet.', 400);
          const files = {} as Record<UploadField, Buffer>;
          const documents = {} as Record<typeof examFields[number], { name: string; buffer: Buffer; pages: number }>;
          const start = Date.now();
          let answerPages = 0;
          for (const field of uploadFields) {
            const uploaded = input[field]?.[0];
            const retained = field === 'answerSheet' ? undefined : saved?.[field];
            const buffer = uploaded?.buffer ?? Buffer.from(retained!.data, 'base64');
            const pages = await validatePdf(buffer, field, options.maxBytes, options.maxPages);
            files[field] = buffer;
            if (field !== 'answerSheet') documents[field] = { name: uploaded?.originalname ?? retained!.name, buffer, pages };
            if (field === 'answerSheet') answerPages = pages;
          }
          const retainedMetadata = options.retainedExam ? (examFields.some(field => !!input[field]) ? await options.retainedExam.save(documents) : options.retainedExam.metadata(saved ?? null)) : null;
          const run = await options.store.create(files, selectedModel);
          run.stageModels = model.stageModels ?? Object.fromEntries(['extracting_exam', 'transcribing', 'resolving_answers', 'evaluating'].map(stage => [stage, selectedModel]));
          run.stageDurations.validating = Date.now() - start;
          res.status(202).json({ id: run.id, retainedExam: retainedMetadata });
          void processRun(run, options.store, model, answerPages);
        } catch (error) { options.store.release(); next(error); }
      })();
    });
  });
  app.get('/api/evaluations/:id', (req, res, next) => {
    const run = options.store.get(req.params.id);
    if (!run) return next(new AppError('NOT_FOUND', 'Evaluation not found. It may have expired or the server restarted. Upload again.', 404));
    res.json(run);
  });
  app.patch('/api/evaluations/:id/questions/:questionId', express.json({ limit: '8kb' }), (req, res, next) => {
    const run = options.store.get(req.params.id);
    if (!run) return next(new AppError('NOT_FOUND', 'Evaluation expired or server restarted. Upload again.', 404));
    if (run.stage !== 'completed') return next(new AppError('RUN_ACTIVE', 'Only completed evaluations can be reviewed.', 409));
    const result = run.results.find(r => r.identifier === req.params.questionId);
    if (!result) return next(new AppError('NOT_FOUND', 'Question not found.', 404));
    const input = z.object({ marks: z.number().finite().min(0).max(result.maximumMarks), reason: z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
    if (!input.success) return next(new AppError('INVALID_REVIEW', `Enter marks between 0 and ${result.maximumMarks} and a review reason.`, 400));
    result.teacherAdjustment = { ...input.data, updatedAt: Date.now() };
    run.totals = calculateTotals(run.results);
    res.json(run);
  });
  app.delete('/api/evaluations/:id', (req, res, next) => {
    void options.store.remove(req.params.id).then(() => res.status(204).end()).catch(next);
  });
  app.get('/api/evaluations/:id/answer-sheet', (req, res, next) => {
    if (!options.store.get(req.params.id)) return next(new AppError('NOT_FOUND', 'The answer sheet expired or the server restarted. Upload again.', 404));
    void options.store.read(req.params.id, 'answerSheet').then(bytes => { res.type('application/pdf').set('Content-Disposition', 'inline; filename="answer-sheet.pdf"').send(bytes); }).catch(next);
  });
  if (options.examCatalog) registerExamRoutes(app, { ...options, examCatalog: options.examCatalog });
  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'API endpoint not found.', 404)));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const safe = error instanceof multer.MulterError
      ? new AppError(error.code, error.code === 'LIMIT_FILE_SIZE' ? `Each PDF must be at most ${options.maxBytes / 1024 / 1024} MB.` : 'Upload exactly the three expected PDF files, with no additional fields.', 400)
      : publicError(error);
    res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  });
  return app;
}
