import { defaultDate, lastDay } from './ledger';

describe('ultimo giorno del mese', () => {
  it.each([
    ['2026-10-01', '2026-10-31'],
    ['2026-12-01', '2026-12-31'],
    ['2027-02-01', '2027-02-28'],
    ['2028-02-01', '2028-02-29'],
  ])('%s → %s', (month, day) => {
    expect(lastDay(month)).toBe(day);
  });
});

describe('data proposta per un movimento nuovo', () => {
  it('nel mese corrente è oggi', () => {
    expect(defaultDate('2026-11-01', '2026-11-08')).toBe('2026-11-08');
  });

  it('in un mese passato è il suo ultimo giorno', () => {
    expect(defaultDate('2026-10-01', '2026-11-08')).toBe('2026-10-31');
  });

  it('in un mese futuro resta oggi', () => {
    expect(defaultDate('2026-12-01', '2026-11-08')).toBe('2026-11-08');
  });
});
