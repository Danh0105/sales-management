import { TimetableImportService } from './timetable-import.service';
import { ExtractedEntry } from './timetable.types';

describe('TimetableImportService entry changes', () => {
  const service = new TimetableImportService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const entries: ExtractedEntry[] = [
    {
      dayOfWeek: 2,
      session: 'SANG',
      period: 1,
      className: '2A',
      confidence: 'low',
    },
    {
      dayOfWeek: 3,
      session: 'CHIEU',
      period: 2,
      className: '3B',
      confidence: 'high',
    },
  ];

  const apply = (changes: unknown[]) =>
    (
      service as unknown as {
        applyEntryChanges: (
          current: ExtractedEntry[],
          changes: unknown[],
        ) => { entries: ExtractedEntry[]; skipped: number };
      }
    ).applyEntryChanges(entries, changes);

  it('updates exactly one matched entry and marks the human-reviewed value high confidence', () => {
    const result = apply([
      {
        action: 'UPDATE',
        matchDayOfWeek: 2,
        matchSession: 'SANG',
        matchPeriod: 1,
        matchClassName: '2a',
        dayOfWeek: null,
        session: null,
        period: 2,
        className: '2B',
      },
    ]);

    expect(result.skipped).toBe(0);
    expect(result.entries[0]).toMatchObject({
      dayOfWeek: 2,
      session: 'SANG',
      period: 2,
      className: '2B',
      confidence: 'high',
    });
  });

  it('adds and deletes entries', () => {
    const result = apply([
      {
        action: 'DELETE',
        matchDayOfWeek: 3,
        matchSession: 'CHIEU',
        matchPeriod: 2,
        matchClassName: '3B',
        dayOfWeek: null,
        session: null,
        period: null,
        className: null,
      },
      {
        action: 'ADD',
        matchDayOfWeek: null,
        matchSession: null,
        matchPeriod: null,
        matchClassName: null,
        dayOfWeek: 4,
        session: 'SANG',
        period: 3,
        className: '4C',
      },
    ]);

    expect(result.skipped).toBe(0);
    expect(result.entries.map((entry) => entry.className)).toEqual([
      '2A',
      '4C',
    ]);
  });

  it('does not apply an ambiguous update', () => {
    const result = apply([
      {
        action: 'UPDATE',
        matchDayOfWeek: null,
        matchSession: null,
        matchPeriod: null,
        matchClassName: null,
        dayOfWeek: 4,
        session: null,
        period: null,
        className: null,
      },
    ]);

    expect(result.skipped).toBe(1);
    expect(result.entries).toEqual(entries);
  });
});
