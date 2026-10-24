import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAIModel } from './model.js';
import { modelContext, requestContext, diagnosticFetch, type TaskRecord } from './model-diagnostics.js';
import { transcriptionFixture, examFixture, gradingFixture } from './test-fixtures.js';

const response = () => ({ id: 'resp_saved', status: 'completed', output: [], output_text: JSON.stringify(transcriptionFixture()), usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
function context() {
  const records = new Map<string, TaskRecord>();
    return { records, scope: { runId: 'submission-test', examId: 'exam-test', load: async (key: string) => records.get(key) ?? null, save: async (key: string, record: TaskRecord) => { records.set(key, structuredClone(record)); } } };
}
describe('Model diagnostics and recovery', () => {
  it('preserves successful question responses when another question fails and replays only unresolved work', async () => {
    const c = context(); let fail = true;
    const create = vi.fn(async (request: any) => {
      const input = JSON.parse(request.input[0].content[0].text); const question = input.exam.questions[0];
      if (question.identifier === '2(a)' && fail) throw new OpenAI.APIConnectionTimeoutError();
      const { marks, provisionalMarks, ...rest } = gradingFixture().results.find(r => r.identifier === question.identifier)!;
      return { ...response(), output_text: JSON.stringify({ results: { [question.identifier]: { ...rest, assessedMarks: marks, uncertaintyDecisions: {} } }, warnings: [] }) };
    });
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'test', { parallelGrading: true });
    await expect(modelContext.run(c.scope, () => model.grade(examFixture(), transcriptionFixture()))).rejects.toThrow();
    expect([...c.records.values()].filter(r => r.outcome === 'received')).toHaveLength(1);
    fail = false;
    const recovered = await modelContext.run(c.scope, () => model.grade(examFixture(), transcriptionFixture()));
    expect(create).toHaveBeenCalledTimes(3);
    expect((recovered.value as any).results.map((r: any) => r.marks)).toEqual([2, 3]);
  });
  it('stores responses when configured, correlates requests and reuses completed work without another API call', async () => {
    const create = vi.fn(async () => response()); const c = context();
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'test', { storeResponses: true });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const first = await modelContext.run(c.scope, () => model.transcribe(Buffer.from('private answer text')));
      const second = await modelContext.run(c.scope, () => model.transcribe(Buffer.from('private answer text')));
      expect(first).toEqual(second); expect(create).toHaveBeenCalledTimes(1);
      const args = (create.mock.calls as unknown as Array<[any, any]>)[0];
      expect(args[0]).toMatchObject({ store: true, metadata: { submission_id: 'submission-test', stage: 'transcription' } });
      expect(args[1].headers['X-Client-Request-Id']).toBeTruthy();
      expect([...c.records.values()][0]).toMatchObject({ outcome: 'received', responseId: 'resp_saved' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('private answer text');
      expect(JSON.stringify(log.mock.calls)).not.toContain('output_text');
      await modelContext.run(c.scope, () => model.transcribe(Buffer.from('changed sheet')));
      expect(create).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });
  it('marks a timeout unknown and sends no automatic application retry', async () => {
    const create = vi.fn().mockRejectedValueOnce(new OpenAI.APIConnectionTimeoutError()).mockResolvedValueOnce(response()); const c = context();
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'test');
    await expect(modelContext.run(c.scope, () => model.transcribe(Buffer.from('sheet')))).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1); expect([...c.records.values()][0].outcome).toBe('unknown');
    const oldId = [...c.records.values()][0].clientRequestId;
    await modelContext.run(c.scope, () => model.transcribe(Buffer.from('sheet')));
    expect([...c.records.values()][0].clientRequestId).not.toBe(oldId);
  });
  it('retrieves a known completed response and does not create a duplicate', async () => {
    const c = context(); const create = vi.fn(async () => response()); const retrieve = vi.fn(async () => response());
    const model = new OpenAIModel({ responses: { create, retrieve } } as unknown as OpenAI, 'test');
    await modelContext.run(c.scope, () => model.transcribe(Buffer.from('sheet')));
    const [key, record] = [...c.records][0]; delete record.response; c.records.set(key, record);
    await modelContext.run(c.scope, () => model.transcribe(Buffer.from('sheet')));
    expect(retrieve).toHaveBeenCalledWith('resp_saved'); expect(create).toHaveBeenCalledTimes(1);
    delete record.response; c.records.set(key, record); retrieve.mockResolvedValueOnce({ ...response(), status: 'in_progress' });
    await expect(modelContext.run(c.scope, () => model.transcribe(Buffer.from('sheet')))).rejects.toThrow(/still processing/);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('logs transport attempts without leaking headers, bodies or raw errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('secret authorization body')); vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await expect(requestContext.run({ clientRequestId: 'client-test', task: 'grading', questionIds: ['1'] }, () => diagnosticFetch('https://example.test', { headers: { authorization: 'secret-key', 'x-stainless-retry-count': '2' }, body: 'student secret' }))).rejects.toThrow();
      const logged = JSON.stringify(log.mock.calls);
      expect(log.mock.calls.map(([line]) => JSON.parse(line)).every(event => event.attempt === 3)).toBe(true); expect(logged).not.toContain('secret');
    } finally { log.mockRestore(); vi.unstubAllGlobals(); }
  });
});
