import { formatCents, parseAmount } from './money';

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

describe('formatCents', () => {
  it('formatta in euro all’italiana (migliaia raggruppate da 5 cifre, come da CLDR)', () => {
    expect(formatCents(1234567).replace(/\s/g, ' ')).toBe('12.345,67 €');
    expect(formatCents(123456).replace(/\s/g, ' ')).toBe('1234,56 €');
    expect(formatCents(-750).replace(/\s/g, ' ')).toBe('-7,50 €');
  });
});
