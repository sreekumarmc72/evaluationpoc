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

const store = new RunStore(await mkdtemp(path.join(tmpdir(), 'answer-evaluation-')), config.retentionMs);
const client = new OpenAI({ apiKey: config.apiKey || 'not-configured', timeout: config.timeout, maxRetries: 2 });
const retainedExam = new RetainedExamStore(fileURLToPath(new URL('../../../.local-exam/', import.meta.url)));
const examCatalog = new ExamCatalog(fileURLToPath(new URL('../../../.local-data/exams/', import.meta.url)));
await examCatalog.initialize();
const sol = new OpenAIModel(client, 'gpt-6.1-sol', { parallelGrading: true, examStorage: retainedExam });
const luna = new OpenAIModel(client, 'gpt-6-luna', { examStorage: retainedExam });
const models: Record<string, import('./model.js').EvaluationModel> = { 'gpt-6.1-sol': sol, 'gpt-6-luna': luna, 'luna-sol': createStageRoutedModel(luna, sol), 'sol-ultrafast': sol.withServiceTier('ultrafast') };
const app = createApp({ ...config, store, retainedExam, examCatalog, models, model: models[config.model] ?? new OpenAIModel(client, config.model, { examStorage: retainedExam }), modelId: config.model, configured: !!config.apiKey && !!config.model });
const server = app.listen(config.port, '127.0.0.1', () => {
  console.info(`API listening on http://127.0.0.1:${config.port}`);
  if (!config.apiKey || !config.model) console.info('Configure OPENAI_API_KEY and OPENAI_MODEL in .env to enable evaluations.');
});
const cleanup = setInterval(() => { void store.cleanup().catch(() => console.error('Temporary-file cleanup failed.')); }, 30000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  clearInterval(cleanup);
  // Graceful exit drops process state. Delete this process-owned temporary directory.
  server.close(() => { void store.dispose().finally(() => process.exit(0)); });
});
