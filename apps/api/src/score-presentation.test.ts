import { describe, expect, it } from 'vitest';
import { displayedTotals, roundDisplayedTotal, type Totals } from '@poc/shared';

describe('Score presentation', () => {
  it.each([[24.75, 25], [21.25, 21], [21.5, 21.5], [21.49, 21], [21.51, 22], [0, 0], [0.25, 0], [0.5, 0.5], [0.75, 1], [25, 25]])('displays %s as %s', (raw, expected) => {
    expect(roundDisplayedTotal(raw, 25)).toBe(expected);
  });
  it('never exceeds fractional maximum marks', () => {
    expect(roundDisplayedTotal(2.75, 2.75)).toBe(2.75);
    expect(roundDisplayedTotal(2.6, 2.75)).toBe(2.75);
  });
  it('computes percentages from display marks without changing saved calculations', () => {
    const totals: Totals = { maximumMarks: 25, gradedSubtotal: 24.75, totalMarks: 24.75, percentage: 99, pendingQuestions: [], provisionalTotal: 24.75, provisionalPercentage: 99 };
    const before = structuredClone(totals);
    expect(displayedTotals(totals)).toMatchObject({ gradedSubtotal: 25, totalMarks: 25, percentage: 100, provisionalTotal: 25, provisionalPercentage: 100 });
    expect(totals).toEqual(before);
    expect(displayedTotals({ ...totals, gradedSubtotal: 21.25, totalMarks: 21.25 }).percentage).toBe(84);
  });
  it('preserves pending status and unavailable totals while rounding a provisional total', () => {
    const totals: Totals = { maximumMarks: 25, gradedSubtotal: 18.25, totalMarks: null, percentage: null, pendingQuestions: ['1'], provisionalTotal: 21.75, provisionalPercentage: 87 };
    expect(displayedTotals(totals)).toMatchObject({ gradedSubtotal: 18, totalMarks: null, percentage: null, pendingQuestions: ['1'], provisionalTotal: 22, provisionalPercentage: 88 });
    expect(displayedTotals({ ...totals, provisionalTotal: null }).provisionalTotal).toBeNull();
  });
});
