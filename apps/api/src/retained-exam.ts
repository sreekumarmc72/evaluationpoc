import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { Exam } from '@poc/shared';
import { validateExam } from './validation.js';

export const examFields = ['questionPaper', 'answerKey'] as const;
type ExamField = typeof examFields[number];
const documentSchema = z.object({ name: z.string(), data: z.string(), pages: z.number().int().positive() });
const savedSchema = z.object({ questionPaper: documentSchema, answerKey: documentSchema });
type Saved = z.infer<typeof savedSchema>;
export class RetainedExamStore {
  constructor(private root: string) {}
  private async atomicWrite(filename: string, value: unknown) {
    await mkdir(this.root, { recursive: true });
    const temporary = path.join(this.root, `${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await rename(temporary, path.join(this.root, filename)); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async read(): Promise<Saved | null> {
    try { return savedSchema.parse(JSON.parse(await readFile(path.join(this.root, 'documents.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  metadata(saved: Saved | null) {
    return saved ? Object.fromEntries(examFields.map(field => [field, { name: saved[field].name, size: Buffer.from(saved[field].data, 'base64').length, pages: saved[field].pages }])) : null;
  }
  async save(documents: Record<ExamField, { name: string; buffer: Buffer; pages: number }>) {
    const saved = Object.fromEntries(examFields.map(field => [field, { name: documents[field].name, data: documents[field].buffer.toString('base64'), pages: documents[field].pages }])) as Saved;
    await this.atomicWrite('documents.json', saved);
    return this.metadata(saved);
  }
  async clear() {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names) if (name === 'documents.json' || /^[a-f0-9]{64}\.json$/.test(name)) await unlink(path.join(this.root, name));
  }
  async get(key: string): Promise<Exam | null> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid exam cache key');
    try { return validateExam(JSON.parse(await readFile(path.join(this.root, `${key}.json`), 'utf8'))); }
    catch { return null; } // An invalid/missing cached specification is re-extracted, never trusted.
  }
  async set(key: string, exam: Exam) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid exam cache key');
    await this.atomicWrite(`${key}.json`, validateExam(exam));
    const names = (await readdir(this.root)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    for (const name of names.filter(name => name !== `${key}.json`).slice(19)) await unlink(path.join(this.root, name));
  }
}
