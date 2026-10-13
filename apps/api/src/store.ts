import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { type EvaluationRun, type UploadField, isTerminal, uploadFields } from '@poc/shared';
import { AppError } from './errors.js';

export class RunStore {
  private entries = new Map<string, EvaluationRun>();
  private reserved = false;
  constructor(private root: string, private retentionMs: number) {}
  reserve() {
    if (this.reserved) throw new AppError('BUSY', 'An evaluation is already running. Wait for it to finish.', 409);
    this.reserved = true;
  }
  release() { this.reserved = false; }
  get(id: string) { return this.entries.get(id); }
  private directory(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('NOT_FOUND', 'Evaluation not found. It may have expired or the server restarted. Upload again.', 404);
    const target = path.resolve(this.root, id);
    if (path.dirname(target) !== path.resolve(this.root)) throw new Error('Unsafe run path.');
    return target;
  }
  async create(files: Partial<Record<UploadField, Buffer>>, model: string) {
    const id = randomUUID();
    const dir = this.directory(id);
    await mkdir(dir, { recursive: true });
    try { await Promise.all(uploadFields.filter(field => !!files[field]).map(field => writeFile(path.join(dir, `${field}.pdf`), files[field]!, { flag: 'wx' }))); }
    catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
    const run: EvaluationRun = { id, stage: 'validating', createdAt: Date.now(), finishedAt: null, exam: null, transcription: null, resolution: null, resolvedTranscription: null, results: [], totals: null, warnings: [], error: null, model, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stageDurations: {} };
    this.entries.set(id, run);
    return run;
  }
  read(id: string, field: UploadField) { return readFile(path.join(this.directory(id), `${field}.pdf`)); }
  async remove(id: string) {
    const run = this.entries.get(id);
    if (!run) throw new AppError('NOT_FOUND', 'Evaluation not found. It may have expired or the server restarted. Upload again.', 404);
    if (!isTerminal(run.stage)) throw new AppError('RUN_ACTIVE', 'Wait until the evaluation finishes before removing it.', 409);
    await rm(this.directory(id), { recursive: true, force: true });
    this.entries.delete(id);
  }
  async cleanup(now = Date.now()) {
    for (const run of this.entries.values()) if (run.finishedAt !== null && now - run.finishedAt >= this.retentionMs) await this.remove(run.id);
  }
  async dispose() {
    // root is a process-owned mkdtemp directory, not a user-selected path.
    for (const run of this.entries.values()) await rm(this.directory(run.id), { recursive: true, force: true });
    this.entries.clear();
    await rm(this.root, { recursive: true, force: true });
  }
}

