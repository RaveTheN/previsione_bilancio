import { bucketLeft, inputToForecast, lineKind, moveLine, signedText } from './budget';
import { MonthLine } from './supabase';

const line = (id: string, bucket_id: string | null, forecast: number, actual: number): MonthLine => ({
  id,
  name: id,
  bucket_id,
  sort_order: 0,
  forecast,
  actual,
  n: 1,
});

describe('spostare una riga del mese in un altro secchio', () => {
  it('cambia solo il secchio di quella riga', () => {
    expect(moveLine([line('a', 'fund', -5000, -3000), line('b', 'fund', -100, 0)], 'a', 'fun')).toEqual([
      line('a', 'fun', -5000, -3000),
      line('b', 'fund', -100, 0),
    ]);
  });
});

describe('quanto resta di un secchio', () => {
  it('previsto meno speso, sommando le righe del secchio', () => {
    expect(bucketLeft([line('a', 'fun', -30000, -10000), line('b', 'fun', -5000, 0), line('c', 'altro', -99900, -1)], 'fun')).toBe(25000);
  });

  it('negativo se hai già sforato', () => {
    expect(bucketLeft([line('a', 'fun', -10000, -12000)], 'fun')).toBe(-2000);
  });

  it('un rimborso sulla riga restituisce budget', () => {
    expect(bucketLeft([line('luce', 'fun', -4000, -12000 + 8000)], 'fun')).toBe(0);
  });

  it('senza righe non resta nulla', () => {
    expect(bucketLeft([], 'fun')).toBe(0);
  });
});

describe('previsione nei campi', () => {
  it('le righe senza secchio sono entrate', () => {
    expect([lineKind(null), lineKind('fun')]).toEqual(['income', 'expense']);
  });

  it.each([
    ['500', 'expense', -50000],
    ['-500', 'expense', -50000],
    ['+50', 'expense', 5000],
    ['1800', 'income', 180000],
    ['-50', 'income', -5000],
    ['0', 'expense', 0],
    ['', 'expense', null],
    ['abc', 'expense', undefined],
  ])('"%s" (%s) → %s', (text, kind, cents) => {
    expect(inputToForecast(text, kind)).toBe(cents);
  });

  it.each([
    [-50000, 'expense'],
    [5000, 'expense'],
    [180000, 'income'],
    [-5000, 'income'],
  ])('%i (%s) si rilegge uguale', (cents, kind) => {
    expect(inputToForecast(signedText(cents, kind), kind)).toBe(cents);
  });
});
