import { forecastToInput, inputToForecast } from './budget';

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
