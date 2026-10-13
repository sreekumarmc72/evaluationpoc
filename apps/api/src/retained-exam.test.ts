import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RetainedExamStore } from './retained-exam.js';
import { examFixture } from './test-fixtures.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'retained-exam-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('Retained local exam', () => {
  it('keeps documents and validated cached extraction after reopening, and clears them explicitly', async () => {
    const store = new RetainedExamStore(root);
    await store.save({ questionPaper: { name: '../paper.pdf', buffer: Buffer.from('paper'), pages: 2 }, answerKey: { name: 'key.pdf', buffer: Buffer.from('key'), pages: 1 } });
    const key = 'a'.repeat(64); await store.set(key, examFixture());
    const reopened = new RetainedExamStore(root);
    expect(reopened.metadata(await reopened.read())).toMatchObject({ questionPaper: { name: '../paper.pdf', size: 5, pages: 2 } });
    expect(await reopened.get(key)).toEqual(examFixture());
    await reopened.clear(); expect(await reopened.read()).toBeNull(); expect(await reopened.get(key)).toBeNull();
  });
  it('rejects unsafe cache paths and ignores invalid cached specifications', async () => {
    const store = new RetainedExamStore(root);
    await expect(store.set('../unsafe', examFixture())).rejects.toThrow('Invalid exam cache key');
    await writeFile(path.join(root, `${'b'.repeat(64)}.json`), '{}');
    expect(await store.get('b'.repeat(64))).toBeNull();
  });
});
