import OpenAI from 'openai';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { createApp } from './app.js';
import { OpenAIModel, createStageRoutedModel } from './model.js';
import { RunStore } from './store.js';
import { RetainedExamStore } from './retained-exam.js';
import { fileURLToPath } from 'node:url';
import { ExamCatalog } from './exam-catalog.js';
import { diagnosticFetch, diagnostic } from './model-diagnostics.js';

const store = new RunStore(await mkdtemp(path.join(tmpdir(), 'answer-evaluation-')), config.retentionMs, config.dataDir ? path.resolve(config.dataDir, 'submissions') : fileURLToPath(new URL('../../../.local-data/submissions/', import.meta.url)));
await store.initialize();
const client = new OpenAI({ apiKey: config.apiKey || 'not-configured', timeout: config.timeout, maxRetries: 2, fetch: diagnosticFetch });
diagnostic('model_runtime_configuration', { timeoutMs: config.timeout, maxRetries: 2, storeResponses: config.storeResponses, version: process.env.RENDER_GIT_COMMIT?.slice(0, 40) });
const retainedExam = new RetainedExamStore(config.dataDir ? path.resolve(config.dataDir, 'retained-exam') : fileURLToPath(new URL('../../../.local-exam/', import.meta.url)));
const examCatalog = new ExamCatalog(config.dataDir ? path.resolve(config.dataDir, 'exams') : fileURLToPath(new URL('../../../.local-data/exams/', import.meta.url)));
await examCatalog.initialize();
const sol = new OpenAIModel(client, 'gpt-6.1-sol', { pageReading: true, blueprintPreparation: true, storeResponses: config.storeResponses, parallelGrading: true, examStorage: retainedExam });
const luna = new OpenAIModel(client, 'gpt-6-luna', { pageReading: true, blueprintPreparation: true, storeResponses: config.storeResponses, examStorage: retainedExam });
const models: Record<string, import('./model.js').EvaluationModel> = { 'gpt-6.1-sol': sol, 'gpt-6-luna': luna, 'luna-sol': createStageRoutedModel(luna, sol), 'sol-ultrafast': sol.withServiceTier('ultrafast') };
const app = createApp({ ...config, webRoot: process.env.NODE_ENV === 'production' ? fileURLToPath(new URL('../../web/dist/', import.meta.url)) : undefined, store, retainedExam, examCatalog, models, model: models[config.model] ?? new OpenAIModel(client, config.model, { pageReading: true, blueprintPreparation: true, storeResponses: config.storeResponses, examStorage: retainedExam }), modelId: config.model, configured: !!config.apiKey && !!config.model });
const server = app.listen(config.port, config.host, () => {
  console.info(`Application listening on http://${config.host}:${config.port}`);
  if (!config.apiKey || !config.model) console.info('Configure OPENAI_API_KEY and OPENAI_MODEL in .env to enable evaluations.');
});
const cleanup = setInterval(() => { void store.cleanup().catch(() => console.error('Temporary-file cleanup failed.')); }, 30000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  clearInterval(cleanup);
  // Graceful exit drops process state. Delete this process-owned temporary directory.
  server.close(() => { void store.dispose().finally(() => process.exit(0)); });
});
