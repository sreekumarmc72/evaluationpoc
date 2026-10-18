import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, rename, unlink, readdir, statfs, access } from 'node:fs/promises';
import path from 'node:path';
import { RunSchema, type EvaluationRun, type Exam, type UploadField, isTerminal, uploadFields } from '@poc/shared';
import { AppError } from './errors.js';

export class RunStore {
  private entries = new Map<string, EvaluationRun>();
  private reserved = false;
  private saved = new Map<string, { directory: string; tokenHash: string }>();
  private writes = new Map<string, Promise<void>>();
  private issuedTokens = new Map<string, string>();
  private unreadableRecords: Array<{ examId: string; submissionId: string }> = [];
  constructor(private root: string, private retentionMs: number, private submissionsRoot?: string) {}
  get supportsHistory() { return !!this.submissionsRoot; }
  async initialize() {
    if (!this.submissionsRoot) return;
    await mkdir(this.submissionsRoot, { recursive: true });
    for (const exam of await readdir(this.submissionsRoot, { withFileTypes: true })) {
      if (!exam.isDirectory() || !this.validId(exam.name)) continue;
      const examDirectory = path.join(this.submissionsRoot, exam.name);
      for (const item of await readdir(examDirectory, { withFileTypes: true })) {
        if (!item.isDirectory() || !this.validId(item.name)) continue;
        const directory = path.join(examDirectory, item.name);
        try {
          const run = RunSchema.parse(JSON.parse(await readFile(path.join(directory, 'evaluation.json'), 'utf8')));
          const accessData = JSON.parse(await readFile(path.join(directory, 'access.json'), 'utf8'));
          if (run.id !== item.name || run.examId !== exam.name || !/^[a-f0-9]{64}$/.test(accessData.tokenHash)) throw new Error('Invalid saved submission');
          await access(path.join(directory, 'answerSheet.pdf'));
          run.durable = true;
          this.saved.set(run.id, { directory, tokenHash: accessData.tokenHash }); this.entries.set(run.id, run);
          if (!isTerminal(run.stage)) {
            run.error = { code: 'PROCESSING_INTERRUPTED', message: 'The server restarted before evaluation finished. The answer sheet and available processing details were retained. No automatic re-evaluation was started.', stage: run.stage };
            run.stage = 'failed'; run.finishedAt = Date.now(); await this.checkpoint(run);
          }
        } catch { this.unreadableRecords.push({ examId: exam.name, submissionId: item.name }); console.warn('A damaged submission was preserved on disk but could not be loaded.'); }
      }
    }
  }
  private validId(id: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id); }
  isSaved(id: string) { return this.saved.has(id); }
  takeAccessToken(id: string) { const token = this.issuedTokens.get(id); this.issuedTokens.delete(id); return token; }
  hasAccess(id: string, token: string) {
    const saved = this.saved.get(id); if (!saved || !token || token.length > 256) return false;
    return timingSafeEqual(Buffer.from(saved.tokenHash, 'hex'), createHash('sha256').update(token).digest());
  }
  async checkpoint(run: EvaluationRun) {
    const saved = this.saved.get(run.id); if (!saved) return;
    const bytes = JSON.stringify(RunSchema.parse(run));
    const work = (this.writes.get(run.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const temporary = path.join(saved.directory, `${randomUUID()}.tmp`);
      try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path.join(saved.directory, 'evaluation.json')); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    this.writes.set(run.id, work);
    try { await work; } catch { throw new AppError('STORAGE_FAILURE', 'Could not save the submission to disk. Its result has not been safely saved. Contact the faculty to check available storage.', 507); }
    finally { if (this.writes.get(run.id) === work) this.writes.delete(run.id); }
  }
  list(examId: string) {
    return [...this.entries.values()].filter(run => this.saved.has(run.id) && run.examId === examId).sort((a, b) => b.createdAt - a.createdAt).map(run => {
      const identity = run.transcription?.studentIdentity;
      return { id: run.id, createdAt: run.createdAt, stage: run.stage, model: run.model, totals: run.totals, studentName: identity?.status === 'readable' ? identity.name : null, nameStatus: identity?.status ?? 'absent', interrupted: run.error?.code === 'PROCESSING_INTERRUPTED', error: run.error?.message ?? null };
    });
  }
  async storageUsage() {
    if (!this.submissionsRoot) return null;
    const stats = await statfs(this.submissionsRoot);
    return { totalBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize, usedBytes: (stats.blocks - stats.bfree) * stats.bsize, unreadableRecords: this.unreadableRecords };
  }
  reserve() {
    if (this.reserved) throw new AppError('BUSY', 'An evaluation is already running. Wait for it to finish.', 409);
    this.reserved = true;
  }
  release() { this.reserved = false; }
  get(id: string) { return this.entries.get(id); }
  private directory(id: string) {
    const saved = this.saved.get(id); if (saved) return saved.directory;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('NOT_FOUND', 'Evaluation not found. It may have expired or the server restarted. Upload again.', 404);
    const target = path.resolve(this.root, id);
    if (path.dirname(target) !== path.resolve(this.root)) throw new Error('Unsafe run path.');
    return target;
  }
  async create(files: Partial<Record<UploadField, Buffer>>, model: string, context?: { examId: string; examVersion: number; exam: Exam }) {
    const id = randomUUID();
    let accessToken: string | undefined;
    if (context && this.submissionsRoot) {
      if (!this.validId(context.examId)) throw new AppError('NOT_FOUND', 'Exam not found.', 404);
      accessToken = randomBytes(32).toString('hex');
      this.saved.set(id, { directory: path.join(this.submissionsRoot, context.examId, id), tokenHash: createHash('sha256').update(accessToken).digest('hex') });
    }
    const dir = this.directory(id);
    try { await mkdir(dir, { recursive: true }); await Promise.all(uploadFields.filter(field => !!files[field]).map(field => writeFile(path.join(dir, `${field}.pdf`), files[field]!, { flag: 'wx' }))); }
    catch (error) { await rm(dir, { recursive: true, force: true }); this.saved.delete(id); throw new AppError('STORAGE_FAILURE', 'Unable to save the uploaded PDF. Check disk space before trying again.', 507); }
    const run: EvaluationRun = { id, stage: 'validating', createdAt: Date.now(), finishedAt: null, exam: null, transcription: null, resolution: null, resolvedTranscription: null, results: [], totals: null, warnings: [], error: null, model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stageDurations: {} };
    this.entries.set(id, run);
    if (context) Object.assign(run, context, { examReused: true, durable: this.saved.has(id) });
    if (accessToken) {
      try { await writeFile(path.join(dir, 'access.json'), JSON.stringify({ tokenHash: this.saved.get(id)!.tokenHash }), { flag: 'wx' }); await this.checkpoint(run); }
      catch { this.entries.delete(id); this.saved.delete(id); throw new AppError('STORAGE_FAILURE', 'The submission could not be safely recorded. No evaluation was started.', 507); }
    }
    if (accessToken) this.issuedTokens.set(id, accessToken);
    return run;
  }
  read(id: string, field: UploadField) { return readFile(path.join(this.directory(id), `${field}.pdf`)); }
  async remove(id: string) {
    const run = this.entries.get(id);
    if (!run) throw new AppError('NOT_FOUND', 'Evaluation not found. It may have expired or the server restarted. Upload again.', 404);
    if (!isTerminal(run.stage)) throw new AppError('RUN_ACTIVE', 'Wait until the evaluation finishes before removing it.', 409);
    if (this.saved.has(id)) return; // New submission clears the browser view, never the faculty archive.
    await rm(this.directory(id), { recursive: true, force: true });
    this.entries.delete(id);
  }
  async cleanup(now = Date.now()) {
    for (const run of this.entries.values()) if (!this.saved.has(run.id) && run.finishedAt !== null && now - run.finishedAt >= this.retentionMs) await this.remove(run.id);
  }
  async dispose() {
    // root is a process-owned mkdtemp directory, not a user-selected path.
    await Promise.allSettled([...this.writes.values()]);
    for (const run of this.entries.values()) if (!this.saved.has(run.id)) await rm(this.directory(run.id), { recursive: true, force: true });
    this.entries.clear();
    await rm(this.root, { recursive: true, force: true });
  }
}

