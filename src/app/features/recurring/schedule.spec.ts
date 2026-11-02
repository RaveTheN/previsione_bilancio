import { dueInMonth, nextDue, yearlyCost } from './schedule';

describe('scadenze delle ricorrenti', () => {
  it.each([
    ['2026-02-01', 31, '2026-02-28'],
    ['2028-02-01', 31, '2028-02-29'],
    ['2026-04-01', 31, '2026-04-30'],
    ['2026-04-01', 5, '2026-04-05'],
  ])('%s, giorno %i → %s', (month, day, due) => {
    expect(dueInMonth(month, day)).toBe(due);
  });

  const monthly = { frequency: 'monthly', start_date: '2026-01-31', end_date: null };
  const yearly = { frequency: 'yearly', start_date: '2025-03-15', end_date: null };

  it('mensile: oggi se scade oggi, altrimenti la prossima', () => {
    expect(nextDue(monthly, '2026-11-30')).toBe('2026-11-30');
    expect(nextDue(monthly, '2026-12-01')).toBe('2026-12-31');
    expect(nextDue(monthly, '2027-02-01')).toBe('2027-02-28');
  });

  it('annuale: nel suo mese, anche l\'anno dopo', () => {
    expect(nextDue(yearly, '2026-11-03')).toBe('2027-03-15');
    expect(nextDue(yearly, '2027-03-15')).toBe('2027-03-15');
    expect(nextDue(yearly, '2027-03-16')).toBe('2028-03-15');
  });

  it('non ancora iniziata, o finita', () => {
    expect(nextDue({ ...monthly, start_date: '2027-05-10' }, '2026-11-03')).toBe('2027-05-10');
    expect(nextDue({ ...monthly, end_date: '2026-11-15' }, '2026-11-03')).toBeNull();
  });

  it('costo annuo', () => {
    expect(yearlyCost({ frequency: 'monthly', amount_cents: -1299 })).toBe(-15588);
    expect(yearlyCost({ frequency: 'yearly', amount_cents: -50000 })).toBe(-50000);
  });
});
