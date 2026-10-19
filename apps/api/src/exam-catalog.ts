import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PreparedExamSchema, type PreparedExam, type Exam, type Usage } from '@poc/shared';
import { validateExam } from './validation.js';
import { AppError } from './errors.js';

type Field = 'questionPaper' | 'answerKey';
export class ExamCatalog {
  private entries = new Map<string, { metadata: PreparedExam; specification: Exam | null }>();
  constructor(private root: string) {}
  private validateSpecification(value: unknown) {
    const exam = validateExam(value);
    if (exam.questions.some(question => !question.rubric?.length)) throw new AppError('INVALID_SAVED_EXAM', 'Every prepared question must have a validated rubric.');
    return exam;
  }
  private directory(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new AppError('NOT_FOUND', 'Exam not found.', 404);
    const directory = path.resolve(this.root, id);
    if (path.dirname(directory) !== path.resolve(this.root)) throw new Error('Unsafe exam path');
    return directory;
  }
  private async write(id: string, filename: string, value: unknown) {
    const directory = this.directory(id); await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await rename(temporary, path.join(directory, filename)); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const directory of await readdir(this.root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^[0-9a-f-]{36}$/.test(directory.name)) continue;
      try {
        const metadata = PreparedExamSchema.parse(JSON.parse(await readFile(path.join(this.directory(directory.name), 'metadata.json'), 'utf8')));
        if (metadata.id !== directory.name) throw new Error('Mismatched exam ID');
        let specification: Exam | null = null;
        if (metadata.status === 'ready') {
          try { specification = this.validateSpecification(JSON.parse(await readFile(path.join(this.directory(metadata.id), 'specification.json'), 'utf8'))); }
          catch { metadata.status = 'failed'; metadata.error = { code: 'INVALID_SAVED_EXAM', message: 'Saved exam specification is unreadable. Retry preparation.' }; }
        } else if (metadata.status === 'preparing') {
          metadata.status = 'failed'; metadata.finishedAt = Date.now(); metadata.error = { code: 'PREPARATION_INTERRUPTED', message: 'The backend restarted during preparation. Retry preparation.' };
        }
        this.entries.set(metadata.id, { metadata, specification });
        await this.write(metadata.id, 'metadata.json', metadata);
      } catch { console.warn('A damaged exam catalog entry was skipped.'); }
    }
  }
  list() { return [...this.entries.values()].map(entry => structuredClone(entry.metadata)).sort((a, b) => b.createdAt - a.createdAt); }
  get(id: string) { const entry = this.entries.get(id); if (!entry) throw new AppError('NOT_FOUND', 'Exam not found.', 404); return structuredClone(entry); }
  async create(name: string, model: PreparedExam['model'], documents: Record<Field, { name: string; pages: number; buffer: Buffer }>) {
    const id = randomUUID(); const directory = this.directory(id); await mkdir(directory, { recursive: true });
    for (const field of ['questionPaper', 'answerKey'] as const) await writeFile(path.join(directory, `${field}.pdf`), documents[field].buffer, { flag: 'wx' });
    const metadata: PreparedExam = { id, name, model, version: 1, status: 'preparing', createdAt: Date.now(), finishedAt: null,
      documents: Object.fromEntries(Object.entries(documents).map(([field, value]) => [field, { name: value.name, pages: value.pages, sha256: createHash('sha256').update(value.buffer).digest('hex') }])) as PreparedExam['documents'],
      questionCount: 0, maximumMarks: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 0, warnings: [], error: null };
    await this.write(id, 'metadata.json', metadata); this.entries.set(id, { metadata, specification: null }); return structuredClone(metadata);
  }
  async beginRetry(id: string) {
    const entry = this.get(id); if (entry.metadata.status !== 'failed') throw new AppError('INVALID_EXAM_STATE', 'Only failed exam preparations can be retried.', 409);
    entry.metadata.status = 'preparing'; entry.metadata.error = null; entry.metadata.finishedAt = null; entry.metadata.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; entry.metadata.durationMs = 0;
    await this.write(id, 'metadata.json', entry.metadata); this.entries.set(id, entry);
  }
  read(id: string, field: Field) { return readFile(path.join(this.directory(id), `${field}.pdf`)); }
  async updateName(id: string, name: string) {
    const entry = this.get(id);
    if (entry.metadata.status === 'preparing') throw new AppError('EXAM_ACTIVE', 'Wait for exam preparation to finish before editing its title.', 409);
    const title = name.trim();
    if (!title || title.length > 120) throw new AppError('INVALID_EXAM', 'Enter an exam title of 1–120 characters.', 400);
    entry.metadata.name = title;
    await this.write(id, 'metadata.json', entry.metadata); this.entries.set(id, entry);
    return structuredClone(entry.metadata);
  }
  async archive(id: string) {
    const entry = this.get(id);
    if (entry.metadata.status === 'preparing') throw new AppError('EXAM_ACTIVE', 'Wait for exam preparation to finish before deleting this exam.', 409);
    // Same-filesystem rename is atomic. Retain source files and all submission
    // history for recovery; initialization never loads this private directory.
    const archiveRoot = path.join(path.resolve(this.root), '.deleted');
    await mkdir(archiveRoot, { recursive: true });
    await rename(this.directory(id), path.join(archiveRoot, id));
    this.entries.delete(id);
  }
  async updateModel(id: string, model: PreparedExam['model']) {
    const entry = this.get(id);
    if (entry.metadata.status !== 'ready') throw new AppError('EXAM_NOT_READY', 'Only ready exams can change their evaluation model.', 409);
    entry.metadata.preparationModel ??= entry.metadata.model;
    entry.metadata.model = model;
    await this.write(id, 'metadata.json', entry.metadata);
    this.entries.set(id, entry);
    return structuredClone(entry.metadata);
  }
  async ready(id: string, specification: Exam, usage: Usage, durationMs: number) {
    const exam = this.validateSpecification(specification); const entry = this.get(id);
    await this.write(id, 'specification.json', exam);
    Object.assign(entry.metadata, { status: 'ready', finishedAt: Date.now(), questionCount: exam.questions.length, maximumMarks: exam.questions.reduce((sum, q) => sum + q.maximumMarks, 0), usage, durationMs, warnings: exam.warnings, error: null });
    await this.write(id, 'metadata.json', entry.metadata); entry.specification = exam; this.entries.set(id, entry);
  }
  async failed(id: string, error: { code: string; message: string }, durationMs: number) {
    const entry = this.get(id); Object.assign(entry.metadata, { status: 'failed', finishedAt: Date.now(), error, durationMs });
    await this.write(id, 'metadata.json', entry.metadata); this.entries.set(id, entry);
  }
}
