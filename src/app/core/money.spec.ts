import { deviation, diffTone, formatCents, parseAmount, parseSignedAmount } from './money';

describe('parseAmount', () => {
  it.each([
    ['12', 1200],
    ['12,5', 1250],
    ['12,50', 1250],
    ['12.50', 1250],
    ['1.234', 123400],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    [' 4,20 € ', 420],
  ])('"%s" → %i centesimi', (text, cents) => {
    expect(parseAmount(text)).toBe(cents);
  });

  it.each(['', '0', '0,00', 'abc', '12,', '-5', '1.234,567'])('"%s" non è valido', (text) => {
    expect(parseAmount(text)).toBeNull();
  });
});

describe('parseSignedAmount', () => {
  it.each([
    ['0', 0],
    ['0,00', 0],
    ['-0', 0],
    ['12,50', 1250],
    ['-12,50', -1250],
    ['- 1.234,56 €', -123456],
  ])('"%s" → %i centesimi', (text, cents) => {
    expect(parseSignedAmount(text)).toBe(cents);
  });

  it.each(['', '-', 'abc', '--5'])('"%s" non è valido', (text) => {
    expect(parseSignedAmount(text)).toBeNull();
  });
});

describe('diffTone', () => {
  it.each([
    ['expense', -20000, -24000, 'worse'],
    ['expense', -20000, -18000, 'better'],
    ['expense', -2500, -2500, 'even'],
    ['expense', 0, -500, 'worse'],
    ['income', 180000, 190000, 'better'],
    ['income', 180000, 0, 'worse'],
    ['saving', -27000, -30000, 'better'],
    ['saving', -27000, -20000, 'worse'],
    ['saving', 0, 7000, 'worse'],
  ])('%s: previsto %i, effettivo %i → %s', (kind, forecast, actual, tone) => {
    expect(diffTone(kind as string, forecast as number, actual as number)).toBe(tone);
  });
});

describe('deviation', () => {
  it.each([
    ['expense', -10000, -10500, 'even'],
    ['expense', -10000, -9500, 'even'],
    ['expense', -10000, -11000, 'worse'],
    ['expense', -10000, -12000, 'much-worse'],
    ['expense', -10000, -9000, 'better'],
    ['expense', -10000, -5000, 'much-better'],
    ['income', 100000, 110000, 'better'],
    ['saving', -30000, -36000, 'much-better'],
    ['expense', 0, -500, 'much-worse'],
    ['expense', 0, 0, 'even'],
  ])('%s: previsto %i, effettivo %i → %s', (kind, forecast, actual, level) => {
    expect(deviation(kind as string, forecast as number, actual as number)).toBe(level);
  });
});

describe('formatCents', () => {
  it('formatta in euro all’italiana (migliaia raggruppate da 5 cifre, come da CLDR)', () => {
    expect(formatCents(1234567).replace(/\s/g, ' ')).toBe('12.345,67 €');
    expect(formatCents(123456).replace(/\s/g, ' ')).toBe('1234,56 €');
    expect(formatCents(-750).replace(/\s/g, ' ')).toBe('-7,50 €');
  });
});
