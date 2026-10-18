import OpenAI from 'openai';
import { describe, it, expect, vi } from 'vitest';
import { OpenAIModel } from './model.js';
import { transcriptionFixture, examFixture, gradingFixture } from './test-fixtures.js';
import { directResolution } from './validation.js';
import { RetainedExamStore } from './retained-exam.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function modelWith(response: unknown) {
  const create = vi.fn(async (_request: unknown) => response);
  const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'configured-sol');
  return { create, model };
}
describe('OpenAI adapter', () => {
  it('reuses persistent extraction after a model restart but invalidates by document contents and extraction model', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'exam-model-cache-'));
    try {
      const exam = examFixture(); for (const q of exam.questions) q.rubric = [{ id: 'answer', description: 'Answer', maximumMarks: q.maximumMarks, expectedEvidence: q.expectedAnswer, keyAlignment: 'Key', allocationBasis: 'inferred' }];
      const create = vi.fn(async () => ({ status: 'completed', output: [], output_text: JSON.stringify(exam) }));
      const client = { responses: { create } } as unknown as OpenAI;
      const options = { examStorage: new RetainedExamStore(root) };
      await new OpenAIModel(client, 'gpt-6.1-sol', options).extract(Buffer.from('paper'), Buffer.from('key'));
      const reopened = new OpenAIModel(client, 'gpt-6.1-sol', options);
      expect((await reopened.extract(Buffer.from('paper'), Buffer.from('key'))).examReused).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      await reopened.extract(Buffer.from('paper'), Buffer.from('changed-key'));
      await reopened.extract(Buffer.from('changed-paper'), Buffer.from('key'));
      await new OpenAIModel(client, 'gpt-6-luna', options).extract(Buffer.from('paper'), Buffer.from('key'));
      expect(create).toHaveBeenCalledTimes(4);
      await options.examStorage.clear(); reopened.clearExamCache();
      await reopened.extract(Buffer.from('paper'), Buffer.from('changed-key'));
      expect(create).toHaveBeenCalledTimes(5);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('requests Ultrafast on every stage using the actual Sol model and shares its exam cache', async () => {
    const exam = examFixture();
    for (const q of exam.questions) q.rubric = [{ id: 'answer', description: 'Answer', maximumMarks: q.maximumMarks, expectedEvidence: q.expectedAnswer, keyAlignment: 'Key', allocationBasis: 'inferred' }];
    const results = Object.fromEntries(gradingFixture().results.map(({ marks, provisionalMarks, ...r }) => [r.identifier, { ...r, assessedMarks: marks, uncertaintyDecisions: {} }]));
    const create = vi.fn(async (request: any) => ({ status: 'completed', output: [], output_text: JSON.stringify(request.text.format.name === 'exam_with_rubric' ? exam : request.text.format.name === 'transcription' ? transcriptionFixture() : request.text.format.name === 'answer_resolution' ? directResolution(transcriptionFixture(), examFixture()) : { results, warnings: [] }) }));
    const standard = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'gpt-6.1-sol');
    const ultra = standard.withServiceTier('ultrafast');
    await ultra.extract(Buffer.from('paper'), Buffer.from('key'));
    await ultra.transcribe(Buffer.from('sheet'));
    await ultra.resolve(Buffer.from('sheet'), exam.questions, transcriptionFixture());
    await ultra.grade(examFixture(), transcriptionFixture());
    expect(create).toHaveBeenCalledTimes(4);
    for (const [request] of create.mock.calls) { expect(request.model).toBe('gpt-6.1-sol'); expect(request.service_tier).toBe('ultrafast'); expect(request.store).toBe(false); }
    expect((await standard.extract(Buffer.from('paper'), Buffer.from('key'))).usage.totalTokens).toBe(0);
    expect(create).toHaveBeenCalledTimes(4);
    await standard.transcribe(Buffer.from('sheet'));
    expect(create.mock.calls[4][0]).not.toHaveProperty('service_tier');
    expect(Object.values(ultra.stageModels)).toEqual(Array(4).fill('gpt-6.1-sol'));
  });
  it('does not silently fall back when the requested service tier is rejected', async () => {
    const create = vi.fn(async () => { throw new Error('Unsupported service tier'); });
    const ultra = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'gpt-6.1-sol').withServiceTier('ultrafast');
    await expect(ultra.transcribe(Buffer.from('sheet'))).rejects.toThrow('Unsupported service tier');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('grades questions concurrently, retains full mapping context and aggregates usage in exam order', async () => {
    const exam = examFixture(); const transcription = transcriptionFixture(); const resolution = directResolution(transcription, exam);
    let active = 0; let peak = 0;
    const create = vi.fn(async (request: any) => {
      active++; peak = Math.max(peak, active);
      const payload = JSON.parse(request.input[0].content[0].text);
      const { studentIdentity: _identity, ...gradingTranscription } = transcription;
      expect(payload.transcription).toEqual(gradingTranscription); expect(payload.resolution).toEqual(resolution);
      expect(payload.exam.questions).toHaveLength(1);
      const identifier = payload.exam.questions[0].identifier;
      await new Promise(resolve => setTimeout(resolve, identifier === '1' ? 15 : 1)); active--;
      const { marks, provisionalMarks, ...result } = gradingFixture().results.find(r => r.identifier === identifier)!;
      return { status: 'completed', output: [], output_text: JSON.stringify({ results: { [identifier]: { ...result, assessedMarks: marks, uncertaintyDecisions: {} } }, warnings: ['Shared warning'] }), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    });
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'gpt-6.1-sol', { parallelGrading: true });
    const response = await model.grade(exam, transcription, resolution);
    expect(peak).toBe(2); expect((response.value as any).results.map((r: any) => r.identifier)).toEqual(['1', '2(a)']);
    expect((response.value as any).warnings).toEqual(['Shared warning']); expect(response.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });
  it('drains in-flight grading calls before propagating failure and does not retry or start later batches', async () => {
    const exam = examFixture(); exam.questions.push({ ...exam.questions[0], identifier: '3' });
    let drained = false;
    const create = vi.fn(async (request: any) => {
      const id = JSON.parse(request.input[0].content[0].text).exam.questions[0].identifier;
      if (id === '1') throw new Error('request failed');
      await new Promise(resolve => setTimeout(resolve, 15)); drained = true;
      return { status: 'incomplete', output: [] };
    });
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'gpt-6.1-sol', { parallelGrading: true, gradingConcurrency: 2 });
    await expect(model.grade(exam, transcriptionFixture())).rejects.toThrow('request failed');
    expect(drained).toBe(true); expect(create).toHaveBeenCalledTimes(2);
  });
  it('preserves rubric awards and provisional uncertainty decisions in concurrent requests', async () => {
    const exam = examFixture(); const transcription = transcriptionFixture();
    for (const q of exam.questions) q.rubric = [{ id: `${q.identifier}-R1`, description: 'Correct answer', maximumMarks: q.maximumMarks, expectedEvidence: q.expectedAnswer, keyAlignment: 'Key answer', allocationBasis: 'inferred' }];
    transcription.answers[0].uncertainties = [{ id: 'u1', description: 'Verify digit', sourcePages: [1], scope: 'final_answer', impact: 'potentially_score_changing' }];
    const create = vi.fn(async (request: any) => {
      const q = JSON.parse(request.input[0].content[0].text).exam.questions[0];
      const { marks, provisionalMarks, ...result } = gradingFixture().results.find(r => r.identifier === q.identifier)!;
      const pending = q.identifier === '1';
      return { status: 'completed', output: [], output_text: JSON.stringify({ results: { [q.identifier]: { ...result, status: pending ? 'needs_review' : 'graded', reviewFlags: pending ? ['Verify digit'] : [], uncertaintyDecisions: pending ? { u1: { affectsMarks: true, reason: 'Digit changes credit.' } } : {}, criterionAwards: { [q.rubric[0].id]: { marks: q.maximumMarks, evidence: 'Observed answer', reason: 'Matches expected result', sourceEntryIds: [pending ? 'entry-1' : 'entry-2'] } } } }, warnings: [] }) };
    });
    const response = await new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'gpt-6.1-sol', { parallelGrading: true }).grade(exam, transcription);
    expect((response.value as any).results[0]).toMatchObject({ marks: null, provisionalMarks: 2, criterionAwards: [{ criterionId: '1-R1', marks: 2 }], uncertaintyDecisions: [{ uncertaintyId: 'u1', affectsMarks: true }] });
    expect((response.value as any).results[1].marks).toBe(3);
    const schema = (create.mock.calls[0][0] as any).text.format.schema;
    expect(schema.properties.results.required).toEqual(['1']);
    expect(schema.properties.results.properties['1'].properties.criterionAwards.required).toEqual(['1-R1']);
  });
  it('limits grading concurrency to three even when a larger limit is requested', async () => {
    const exam = examFixture(); exam.questions = Array.from({ length: 7 }, (_, i) => ({ ...exam.questions[0], identifier: String(i + 1) }));
    let active = 0; let peak = 0;
    const create = vi.fn(async (request: any) => {
      active++; peak = Math.max(peak, active);
      const q = JSON.parse(request.input[0].content[0].text).exam.questions[0];
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      const { marks, provisionalMarks, ...result } = gradingFixture().results[0];
      return { status: 'completed', output: [], output_text: JSON.stringify({ results: { [q.identifier]: { ...result, identifier: q.identifier, assessedMarks: 2, uncertaintyDecisions: {} } }, warnings: [] }) };
    });
    const response = await new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'gpt-6.1-sol', { parallelGrading: true, gradingConcurrency: 10 }).grade(exam, transcriptionFixture());
    expect(peak).toBe(3); expect((response.value as any).results).toHaveLength(7); expect(create).toHaveBeenCalledTimes(7);
  });
  it('requires each question and uncertainty decision in the model schema and converts to the public arrays', async () => {
    const t = transcriptionFixture(); t.answers[0].uncertainties = [{ id: 'u1', description: 'Uncertain draft', sourcePages: [1], scope: 'crossed_out', impact: 'non_material' }];
    const results = Object.fromEntries(gradingFixture().results.map(({ marks, provisionalMarks, ...r }) => [r.identifier, { ...r, assessedMarks: marks, uncertaintyDecisions: r.identifier === '1' ? { u1: { affectsMarks: false, reason: 'Clear final answer.' } } : {} }]));
    const { model, create } = modelWith({ status: 'completed', output: [], output_text: JSON.stringify({ results, warnings: [] }) });
    const response = await model.grade(examFixture(), t);
    expect((response.value as any).results[0].uncertaintyDecisions).toEqual([{ uncertaintyId: 'u1', affectsMarks: false, reason: 'Clear final answer.' }]);
    const schema = (create.mock.calls[0][0] as any).text.format.schema;
    expect(schema.properties.results.required).toEqual(['1', '2(a)']);
    expect(schema.properties.results.properties['1'].required).toContain('assessedMarks');
    expect(schema.properties.results.properties['1'].properties).not.toHaveProperty('provisionalMarks');
    expect(schema.properties.results.properties['1'].properties.uncertaintyDecisions.required).toEqual(['u1']);
    delete (results['1'].uncertaintyDecisions as any).u1;
    await expect(modelWith({ status: 'completed', output: [], output_text: JSON.stringify({ results, warnings: [] }) }).model.grade(examFixture(), t)).rejects.toThrow(/schema/);
    (results['1'].uncertaintyDecisions as any).u1 = { affectsMarks: false, reason: 'Clear final answer.' };
    await expect(modelWith({ status: 'completed', output: [], output_text: JSON.stringify({ results: { ...results, '99': results['1'] }, warnings: [] }) }).model.grade(examFixture(), t)).rejects.toThrow(/schema/);
  });
  it('preserves a positive assessed award as provisional when the model recommends review', async () => {
    const results = Object.fromEntries(gradingFixture().results.map(({ marks, provisionalMarks, ...r }) => [r.identifier, { ...r, status: 'needs_review', assessedMarks: marks, reviewFlags: ['Verify one digit.'], uncertaintyDecisions: {} }]));
    const response = await modelWith({ status: 'completed', output: [], output_text: JSON.stringify({ results, warnings: [] }) }).model.grade(examFixture(), transcriptionFixture());
    expect((response.value as any).results[0]).toMatchObject({ marks: null, provisionalMarks: 2, status: 'needs_review' });
  });
  it('sends no expected answers, marks, calibration or key PDF to resolution', async () => {
    const t = transcriptionFixture();
    const { model, create } = modelWith({ status: 'completed', output: [], output_text: JSON.stringify(directResolution(t, examFixture())) });
    await model.resolve(Buffer.from('sheet'), examFixture().questions, t);
    const call = create.mock.calls[0][0] as any;
    const content = call.input[0].content;
    expect(content.filter((c: any) => c.type === 'input_file')).toHaveLength(1);
    const payload = JSON.parse(content.find((c: any) => c.type === 'input_text').text);
    expect(payload.questions).toEqual(examFixture().questions.map(({ identifier, text }) => ({ identifier, text })));
    expect(JSON.stringify(payload)).not.toContain('expectedAnswer');
    expect(JSON.stringify(payload)).not.toContain('markingCriteria');
    expect(call.store).toBe(false);
  });
  it('sends only the sheet to transcription with high-detail PDF, strict schema, and store=false', async () => {
    const { create, model } = modelWith({ status: 'completed', output: [], output_text: JSON.stringify(transcriptionFixture()), usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
    expect((await model.transcribe(Buffer.from('sheet'))).usage.totalTokens).toBe(5);
    const call = create.mock.calls[0][0] as any;
    expect(call.model).toBe('configured-sol'); expect(call.store).toBe(false); expect(call.text.format.strict).toBe(true);
    expect(call.input[0].content).toEqual([{ type: 'input_file', filename: 'answer-sheet.pdf', file_data: 'data:application/pdf;base64,c2hlZXQ=', detail: 'high' }]);
  });
  it.each(['refusal', 'incomplete', 'json', 'schema'])('rejects %s output', async kind => {
    const response = { status: kind === 'incomplete' ? 'incomplete' : 'completed', output: kind === 'refusal' ? [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] : [], output_text: kind === 'json' ? 'bad' : '{}' };
    await expect(modelWith(response).model.transcribe(Buffer.from('sheet'))).rejects.toThrow();
  });
  it('uses independent extraction and grading requests without conversation state', async () => {
    const exam = examFixture();
    for (const q of exam.questions) q.rubric = [{ id: 'answer', description: 'Expected answer', maximumMarks: q.maximumMarks, expectedEvidence: q.expectedAnswer, keyAlignment: 'Provided key answer', allocationBasis: 'inferred' }];
    const { model, create } = modelWith({ status: 'completed', output: [], output_text: JSON.stringify(exam) });
    await model.extract(Buffer.from('paper'), Buffer.from('key'));
    const call = create.mock.calls[0][0] as any; expect(call.input[0].content.filter((c: any) => c.type === 'input_file')).toHaveLength(2); expect(call.previous_response_id).toBeUndefined();
  });
  it('lets the SDK retry transient failures at most twice', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      return new Response(attempts < 3 ? JSON.stringify({ error: { message: 'temporary', type: 'server_error' } }) : JSON.stringify({ object: 'response', id: 'resp_test', status: 'completed', output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(transcriptionFixture()), annotations: [] }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }), { status: attempts < 3 ? 500 : 200, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
    });
    const client = new OpenAI({ apiKey: 'test', maxRetries: 2, timeout: 1000, fetch: fetchMock });
    await new OpenAIModel(client, 'test-sol').transcribe(Buffer.from('sheet')); expect(attempts).toBe(3);
  });
});
