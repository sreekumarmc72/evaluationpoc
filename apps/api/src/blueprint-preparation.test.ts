import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import OpenAI from 'openai';
import { OpenAIModel } from './model.js';
import { frBlueprint, frExam } from './blueprint-fixtures.js';
import { modelContext, type TaskRecord } from './model-diagnostics.js';
describe('Blueprint-first preparation', () => {
  it('keeps paper reading key-independent, maps both OR branches, resumes batches and produces a validated 100-mark exam', async () => {
    const doc = await PDFDocument.create(); doc.addPage(); const pdf = Buffer.from(await doc.save());
    let failRubric = true;
    const create = vi.fn(async (request: any) => {
      const name = request.text.format.name; let value: unknown;
      if (name === 'exam_blueprint_v2') value = frBlueprint();
      else if (name === 'blueprint_key_mapping') value = { mappings: frExam().keyMappings, issues: [], warnings: [], policyVersion: null };
      else {
        const input = JSON.parse(request.input[0].content[0].text);
        if (failRubric && input.questions.some((q: any) => q.identifier === 'II-4-a')) throw new OpenAI.APIConnectionTimeoutError();
        value = { rubrics: Object.fromEntries(input.questions.map((q: any) => [q.identifier, frExam().questions.find(item => item.identifier === q.identifier)!.rubric])), issues: [], warnings: [] };
      }
      return { id: `response-${create.mock.calls.length}`, status: 'completed', output: [], output_text: JSON.stringify(value), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    });
    const records = new Map<string, TaskRecord>(); const progress = vi.fn(async () => {});
    const context = { runId: 'prep', load: async (key: string) => records.get(key) ?? null, save: async (key: string, value: TaskRecord) => { records.set(key, structuredClone(value)); }, progress };
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'test', { blueprintPreparation: true });
    await expect(modelContext.run(context, () => model.extract(pdf, pdf))).rejects.toThrow();
    const firstCount = create.mock.calls.length; failRubric = false;
    const prepared = await modelContext.run(context, () => model.extract(pdf, pdf));
    expect((prepared.value as any).blueprint.maximumMarks).toBe(100);
    expect((prepared.value as any).questions.every((q: any) => q.rubric.length)).toBe(true);
    expect(create.mock.calls.filter(([r]) => r.text.format.name === 'exam_blueprint_v2')).toHaveLength(1);
    expect(create.mock.calls.filter(([r]) => r.text.format.name === 'blueprint_key_mapping')).toHaveLength(1);
    expect(create.mock.calls.length).toBeGreaterThan(firstCount);
    const paperCall = create.mock.calls[0][0];
    expect(paperCall.input[0].content.map((c: any) => c.filename)).toEqual(['question-paper.pdf']);
    expect(JSON.stringify(paperCall)).not.toContain('Supplied key answer');
    const mappingCall = create.mock.calls.find(([r]) => r.text.format.name === 'blueprint_key_mapping')![0];
    expect(mappingCall.input[0].content[1].filename).toBe('answer-key.pdf');
    expect(progress).toHaveBeenCalledWith('mapping_key', expect.objectContaining({ version: 2 }));
  });
});
