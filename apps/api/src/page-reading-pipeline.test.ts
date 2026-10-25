import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import type { Exam } from '@poc/shared';
import { OpenAIModel } from './model.js';
import { evaluatePreparedExam } from './evaluation.js';
import { modelContext, type TaskRecord } from './model-diagnostics.js';

describe('Page reader integration with existing evaluation', () => {
  it('preserves raw readings, maps continuations and grades the fixed rubric without exposing identity or the key to reading', async () => {
    const exam: Exam = { policyVersion: null, optionalQuestions: false, issues: [], warnings: [], questions: [{ identifier: '1', text: 'Pass the required journal entries', maximumMarks: 6, expectedAnswer: 'PRIVATE_KEY_TEXT', acceptedAlternatives: [], markingCriteria: [], gradingBasis: 'inferred', rubric: [{ id: 'R1', maximumMarks: 6, description: 'Correct journals', expectedEvidence: 'Required accounts and amounts', keyAlignment: 'Supplied key', allocationBasis: 'inferred' }] }] };
    const create = vi.fn(async (request: any) => {
      const name = request.text.format.name; let value: unknown;
      if (name.startsWith('page_reading')) {
        const input = JSON.parse(request.input[0].content[0].text);
        value = { pages: Object.fromEntries(input.originalPages.map((p: number) => [String(p), { status: 'complete', blocks: [
          ...(p === 1 ? [{ kind: 'administrative', text: 'Student Name: Visible Student', box: { x0: 20, y0: 10, x1: 800, y1: 100 }, uncertain: false, note: '' }] : []),
          { kind: 'answer', text: p === 1 ? '1(i) Machinery account Dr 200000' : 'Continued: Bank account Cr 200000', box: { x0: 20, y0: 120, x1: 800, y1: 800 }, uncertain: false, note: '' },
        ], warnings: [], studentIdentity: p === 1 ? { name: 'Visible Student', status: 'readable', sourcePages: [1], note: 'Labelled name field' } : null }])) };
      } else if (name.startsWith('page_structuring')) {
        const input = JSON.parse(request.input[0].content[0].text);
        value = { pages: Object.fromEntries(input.pages.map((p: any) => [String(p.page), { segments: [{ identifier: p.page === 1 ? '1(i)' : null, sources: p.blocks.map((b: any) => ({ blockId: b.id, quote: b.text })), withdrawn: false, withdrawalEvidence: '', uncertaintyNotes: [], unsupportedContent: false, uncertainties: [] }], warnings: [] }])) };
      } else if (name === 'answer_resolution') {
        const input = JSON.parse(request.input[0].content[1].text);
        value = { mappings: input.transcription.answers.map((a: any) => ({ entryId: a.entryId, questionId: '1', candidateQuestionIds: ['1'], evidence: `Visible journal continuation on page ${a.sourcePages[0]}` })), readings: [], warnings: [] };
        expect(JSON.stringify(input)).not.toContain('PRIVATE_KEY_TEXT'); expect(input.transcription).not.toHaveProperty('pageReadings');
      } else {
        const input = JSON.parse(request.input[0].content[0].text);
        expect(name).toBe('grading'); expect(JSON.stringify(input)).not.toContain('Visible Student'); expect(input.transcription).not.toHaveProperty('pageReadings');
        value = { results: { '1': { identifier: '1', maximumMarks: 6, status: 'graded', justification: 'Correct matching entries across two pages.', correctPoints: ['Required accounts and amounts'], missingPoints: [], reviewFlags: [], notes: [], uncertaintyDecisions: {}, criterionAwards: { R1: { marks: 6, evidence: 'Machinery Dr and Bank Cr 200000', reason: 'Matches required journal', sourceEntryIds: input.transcription.answers.map((a: any) => a.entryId) } } } }, warnings: [] };
      }
      if (name.startsWith('page_')) { expect(JSON.stringify(request.input)).not.toContain('PRIVATE_KEY_TEXT'); expect(JSON.stringify(request.input)).not.toContain('maximumMarks'); }
      return { id: `response-${create.mock.calls.length}`, status: 'completed', output: [], output_text: JSON.stringify(value), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    });
    const model = new OpenAIModel({ responses: { create } } as unknown as OpenAI, 'test', { pageReading: true, pageRenderer: async () => ({ count: 2, render: async page => ({ page, data: Buffer.from('test-image'), width: 1200, height: 1800 }), dispose: async () => {} }) });
    const records = new Map<string, TaskRecord>(); const context = { runId: 'integration', load: async (key: string) => records.get(key) ?? null, save: async (key: string, value: TaskRecord) => { records.set(key, value); } };
    const result = await modelContext.run(context, () => evaluatePreparedExam(model, exam, Buffer.from('pdf'), 2));
    expect(result.stage).toBe('completed'); expect(result.totals?.totalMarks).toBe(6); expect(result.examReused).toBe(true);
    expect(result.transcription?.answers[1].identifier).toBeNull(); expect(result.resolvedTranscription?.answers[1].identifier).toBe('1');
    expect(result.transcription?.pageReadings?.[0].blocks[0].text).toBe('Student Name: Visible Student');
    expect(result.transcription?.studentIdentity?.name).toBe('Visible Student'); expect(result.results[0].criterionAwards?.[0].sourceEntryIds).toEqual(['entry-1', 'entry-2']);
  });
});
