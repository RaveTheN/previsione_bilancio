import { overPlanned } from './month';

describe('overPlanned', () => {
  const b = (...pcts: (number | null)[]) => pcts.map((forecast_pct) => ({ forecast_pct }));

  it('resta normale fino al 100% compreso', () => {
    expect(overPlanned(b(50, 30, 20))).toBe(false);
    expect(overPlanned(b(33.3, 33.3, 33.4))).toBe(false);
  });

  it('diventa rosso appena la somma supera il 100%', () => {
    expect(overPlanned(b(50, 30, 20.1))).toBe(true);
  });

  it('ignora i secchi senza percentuale e senza secchi non segna nulla', () => {
    expect(overPlanned(b(null, null, null))).toBe(false);
    expect(overPlanned([])).toBe(false);
  });
});
