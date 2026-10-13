import { describe, expect, it } from 'vitest';
import { examFixture, transcriptionFixture, gradingFixture } from './test-fixtures.js';
import { validateTranscription, validateResolution, directResolution, applyResolution, validateGrading, needsResolution } from './validation.js';

describe('Mapping and material uncertainty', () => {
  it('excludes explicitly blank label-only regions while retaining raw content and stable IDs', () => {
    const raw = transcriptionFixture();
    raw.answers.unshift({ ...raw.answers[0], text: '', identifier: '6', uncertainties: [{ id: 'blank', description: 'An overwritten numeral; no answer follows it.', sourcePages: [1], scope: 'mapping', impact: 'non_material' }] });
    const normalized = validateTranscription(raw, 1);
    expect(raw.answers[0].text).toBe('');
    expect(normalized.answers).toHaveLength(2);
    expect(normalized.answers[0].entryId).toBe('entry-2');
    expect(normalized.warnings.join(' ')).toContain('Blank label-only');
  });
  it('does not discard an empty entry representing potentially unreadable written content', () => {
    const raw = transcriptionFixture();
    raw.answers[0].text = '';
    raw.answers[0].uncertainties = [{ id: 'u', description: 'Unreadable final amount', sourcePages: [1], scope: 'final_answer', impact: 'potentially_score_changing' }];
    expect(() => validateTranscription(raw, 1)).toThrow(/needs written content/);
  });
  it('resolves an ambiguous label and unnumbered continuation without altering the raw text', () => {
    const t = transcriptionFixture(); t.answers[1].identifier = '6';
    t.answers.push({ ...t.answers[1], entryId: 'entry-3', identifier: null, text: 'More working' });
    const r = directResolution(t, examFixture());
    for (const m of r.mappings.slice(1)) { m.questionId = '2(a)'; m.candidateQuestionIds = ['2(a)']; m.evidence = 'Pages 1–2 show a continuous solution with the same heading.'; }
    expect(needsResolution(t, examFixture())).toBe(true);
    const resolved = applyResolution(t, validateResolution(r, t, examFixture()));
    expect(t.answers[1].identifier).toBe('6'); expect(t.answers[2].identifier).toBeNull();
    expect(resolved.answers[2].identifier).toBe('2(a)');
    expect(validateGrading(gradingFixture(), examFixture(), resolved, r).totals.totalMarks).toBe(5);
  });
  it.each(['duplicate', 'unknown_entry', 'unknown_question', 'missing', 'no_evidence'])('rejects %s mapping evidence', kind => {
    const t = transcriptionFixture(); const r = directResolution(t, examFixture());
    if (kind === 'duplicate') r.mappings[1] = { ...r.mappings[0] };
    if (kind === 'unknown_entry') r.mappings[0].entryId = 'missing';
    if (kind === 'unknown_question') r.mappings[0].questionId = '99';
    if (kind === 'missing') r.mappings.pop();
    if (kind === 'no_evidence') r.mappings[0].evidence = '';
    expect(() => validateResolution(r, t, examFixture())).toThrow();
  });
  it('scopes ambiguous candidates to the affected question', () => {
    const t = transcriptionFixture(); t.answers[1].identifier = null;
    const r = directResolution(t, examFixture()); r.mappings[1].candidateQuestionIds = ['2(a)'];
    const g = validateGrading(gradingFixture(), examFixture(), t, r);
    expect(g.results[0].marks).toBe(2); expect(g.results[1].marks).toBeNull();
  });
  it('unmapped content blocks only absent classifications when no candidates are known', () => {
    const t = transcriptionFixture(); t.answers[1].identifier = null;
    const g = validateGrading(gradingFixture(), examFixture(), t);
    expect(g.results[0].marks).toBe(2); expect(g.results[1].status).toBe('needs_review');
  });
  it('keeps crossed-out uncertainty informational when the final answer is clear', () => {
    const t = transcriptionFixture();
    t.answers[0].uncertainties = [{ id: 'u1', description: 'Unreadable abandoned draft', sourcePages: [1], scope: 'crossed_out', impact: 'non_material' }];
    const g = gradingFixture(); g.results[0].uncertaintyDecisions = [{ uncertaintyId: 'u1', affectsMarks: false, reason: 'The final answer 4 is clear.' }];
    const result = validateGrading(g, examFixture(), t);
    expect(result.totals.totalMarks).toBe(5); expect(result.results[0].notes.length).toBe(1);
  });
  it.each(['blocking', 'unassessed', 'same_score'])('handles %s uncertain digits by explicit scoring impact', kind => {
    const t = transcriptionFixture(); t.answers[0].uncertainties = [{ id: 'u1', description: 'Could be 4 or 9', sourcePages: [1], scope: 'final_answer', impact: 'potentially_score_changing' }];
    const g = gradingFixture();
    if (kind !== 'unassessed') g.results[0].uncertaintyDecisions = [{ uncertaintyId: 'u1', affectsMarks: kind === 'blocking', reason: kind === 'blocking' ? 'These alternatives earn different marks.' : 'Verified scan reading resolves the digit as 4.' }];
    expect(validateGrading(g, examFixture(), t).results[0].marks).toBe(kind === 'same_score' ? 2 : null);
  });
  it('rejects invented uncertainty IDs and double-counted source entries', () => {
    const t = transcriptionFixture(); const g = gradingFixture();
    g.results[0].uncertaintyDecisions = [{ uncertaintyId: 'invented', affectsMarks: false, reason: 'Fine' }];
    expect(() => validateGrading(g, examFixture(), t)).toThrow(/uncertainty/);
    t.answers.push({ ...t.answers[0] });
    expect(() => validateGrading(gradingFixture(), examFixture(), t)).toThrow(/unique/);
  });
  it('keeps verified readings separate and rejects fabricated or overlapping replacements', () => {
    const t = transcriptionFixture(); const r = directResolution(t, examFixture());
    r.readings = [{ entryId: 'entry-1', originalText: '4', revisedText: '9', sourcePages: [1], evidence: 'The visible loop and stem identify 9.' }];
    expect(applyResolution(t, validateResolution(r, t, examFixture())).answers[0].text).toBe('9');
    expect(t.answers[0].text).toBe('4');
    const grades = gradingFixture(); grades.results[0].marks = 0;
    expect(validateGrading(grades, examFixture(), applyResolution(t, r), r, t).results[0].marks).toBe(0);
    r.readings.push({ ...r.readings[0] }); expect(() => validateResolution(r, t, examFixture())).toThrow(/overlap/);
    r.readings = [{ ...r.readings[0], originalText: 'not in source' }]; expect(() => validateResolution(r, t, examFixture())).toThrow(/original/);
  });
  it('scopes faulty uncertainty annotations to valid parent pages and preserves the raw annotation', () => {
    const t = transcriptionFixture();
    t.answers[0].uncertainties = [{ id: 'u', description: 'Could be 4 or 9', sourcePages: [99], scope: 'final_answer', impact: 'potentially_score_changing' }];
    const normalized = validateTranscription(t, 1);
    expect(t.answers[0].uncertainties[0].sourcePages).toEqual([99]);
    expect(normalized.answers[0].uncertainties[0].sourcePages).toEqual([1]);
    expect(normalized.warnings[0]).toContain('Original annotation');
    expect(validateGrading(gradingFixture(), examFixture(), normalized).results[0].marks).toBeNull();
  });
  it('canonicalises stable IDs and uncertainty IDs in reading order', () => {
    const t = transcriptionFixture(); t.answers[0].entryId = 'random';
    t.answers[0].uncertainties = [{ id: 'random-u', description: 'Uncertain digit', sourcePages: [1], scope: 'final_answer', impact: 'potentially_score_changing' }];
    expect(validateTranscription(t, 1).answers[0]).toMatchObject({ entryId: 'entry-1', uncertainties: [{ id: 'entry-1-uncertainty-1' }] });
  });
});
