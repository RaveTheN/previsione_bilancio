import { spendByMonth } from './rubrica';

it('spesa di un esercente: uscite in positivo, per mese dal più recente, con il totale', () => {
  const rows = [
    { month: '2026-10-01', amount_cents: -1200 },
    { month: '2026-11-01', amount_cents: -500 },
    { month: '2026-10-01', amount_cents: 200 },
  ];
  expect(spendByMonth(rows)).toEqual({
    total: 1500,
    months: [
      { month: '2026-11-01', cents: 500 },
      { month: '2026-10-01', cents: 1000 },
    ],
  });
});
