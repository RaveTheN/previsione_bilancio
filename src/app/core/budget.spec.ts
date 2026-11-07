import { bucketLeft, forecastToInput, inputToForecast, moveLine } from './budget';
import { MonthLine } from './supabase';

describe('spostare una riga del mese in un altro secchio', () => {
  const line = (bucket_id: string, forecast: number | null, actual: number) => ({ category_id: 'c', bucket_id, inflow: null, forecast, actual, n: 1, is_default: false }) as MonthLine;

  it('cambia secchio', () => {
    expect(moveLine([line('fund', -5000, -3000)], 'c', 'fund', 'fun')).toEqual([line('fun', -5000, -3000)]);
  });

  it('se la categoria c\'era già nel secchio di arrivo, si somma', () => {
    expect(moveLine([line('fund', -5000, -3000), line('fun', null, -1000)], 'c', 'fund', 'fun')).toEqual([{ ...line('fun', -5000, -4000), n: 2 }]);
  });
});

describe('quanto resta di un secchio', () => {
  const line = (bucket_id: string | null, forecast: number | null, actual: number) => ({ category_id: 'c', bucket_id, inflow: null, forecast, actual, n: 1, is_default: false }) as MonthLine;

  it('previsto meno speso, sommando le righe del secchio', () => {
    expect(bucketLeft([line('fun', -30000, -10000), line('fun', -5000, 0), line('altro', -99900, -1)], 'fun')).toBe(25000);
  });

  it('negativo se hai già sforato', () => {
    expect(bucketLeft([line('fun', -10000, -12000)], 'fun')).toBe(-2000);
  });

  it('una spesa senza previsione toglie dal budget', () => {
    expect(bucketLeft([line('fun', -10000, 0), line('fun', null, -3000)], 'fun')).toBe(7000);
  });

  it('senza righe non resta nulla', () => {
    expect(bucketLeft([], 'fun')).toBe(0);
  });
});

describe('previsione nei campi', () => {
  it.each([
    ['500', 'expense', -50000],
    ['-500', 'expense', -50000],
    ['+50', 'expense', 5000],
    ['1800', 'income', 180000],
    ['-50', 'income', -5000],
    ['0', 'saving', 0],
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
    [-27000, 'saving'],
  ])('%i (%s) si rilegge uguale', (cents, kind) => {
    expect(inputToForecast(forecastToInput(cents, kind, false), kind)).toBe(cents);
  });

  it('la previsione predefinita non riempie il campo', () => {
    expect(forecastToInput(-27000, 'saving', true)).toBe('');
  });
});
