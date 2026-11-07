import { Bucket, MonthLine } from '../../core/supabase';
import { bucketChart, ChartMonth, lineChart, merchantChart, periodOptions, periodRange, savingsChart, spendingTree } from './chart-data';

const buckets = [
  { id: 'fm', name: 'Future me', target_pct: 15 },
  { id: 'fun', name: 'Fun', target_pct: 35 },
] as Bucket[];

const line = (name: string, bucket_id: string | null, forecast: number, actual: number): MonthLine => ({
  id: name,
  name,
  bucket_id,
  sort_order: 0,
  forecast,
  actual,
  n: 1,
});

function month(key: string, lines: MonthLine[], extra: Partial<ChartMonth> = {}): ChartMonth {
  return {
    month: key,
    lines,
    unassigned: { actual: 0, n: 0 },
    income_forecast: 0,
    income_actual: 0,
    expense_forecast: 0,
    expense_actual: 0,
    saving_forecast: 0,
    saving_actual: 0,
    start_forecast: null,
    start_actual: null,
    end_forecast: null,
    end_actual: null,
    reserve_forecast: null,
    reserve_actual: null,
    buckets: [],
    debt_cents: 0,
    debt_pct: null,
    ...extra,
  };
}

describe('periodo', () => {
  it('non parte prima del mese di avvio', () => {
    expect(periodRange('y2026', '2026-11-01', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-12-01' });
    expect(periodRange('y2027', '2026-11-01', '2026-09-01')).toEqual({ from: '2027-01-01', to: '2027-12-01' });
    expect(periodRange('m6', '2026-11-01', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-11-01' });
    expect(periodRange('m12', '2027-03-01', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2027-03-01' });
    expect(periodRange('m6', '2027-12-01', '2026-09-01')).toEqual({ from: '2027-07-01', to: '2027-12-01' });
    expect(periodRange('m6', '2026-11-01', null)).toEqual({ from: '2026-06-01', to: '2026-11-01' });
  });

  it('propone gli anni dall\'avvio al prossimo', () => {
    expect(periodOptions('2027-02-01', '2026-09-01').map((o) => o.value)).toEqual(['y2026', 'y2027', 'y2028', 'm6', 'm12']);
    expect(periodOptions('2026-11-01', null).map((o) => o.value)).toEqual(['y2026', 'y2027', 'm6', 'm12']);
  });
});

describe('risparmio accumulato', () => {
  const months = [
    month('2026-10-01', [], { reserve_actual: 1000, reserve_forecast: 900 }),
    month('2026-11-01', [], { reserve_actual: 1100, reserve_forecast: 1050 }),
    month('2026-12-01', [], { reserve_actual: 1100, reserve_forecast: 1200 }),
  ];

  it('prende i valori della griglia; l\'effettivo si ferma al mese corrente', () => {
    const spec = savingsChart(months, '2026-11-01');
    expect(spec.series[0].values).toEqual([1000, 1100, null]);
    expect(spec.series[1].values).toEqual([900, 1050, 1200]);
    expect(spec.series[1].dashed).toBe(true);
    expect(spec.summary).toContain('novembre 2026');
    expect(spec.summary).toContain('dicembre 2026');
  });

  it('in un periodo tutto futuro resta solo la previsione', () => {
    const spec = savingsChart(months, '2026-09-01');
    expect(spec.series.map((s) => s.label)).toEqual(['Previsto']);
  });

  it('senza conti di riserva non disegna nulla', () => {
    expect(savingsChart([month('2026-10-01', [])], '2026-11-01').labels).toEqual([]);
  });
});

describe('previsto ed effettivo per riga', () => {
  const months = [
    month('2026-09-01', [line('Stipendio', null, 200000, 210000), line('Spesa', 'fun', -30000, -40000), line('Casa', 'fm', -50000, -50000)]),
    month('2026-10-01', [line('Spesa', 'fun', -30000, -20000), line('Casa', 'fm', 0, -1000)]),
  ];

  it('le uscite sono le righe dei secchi, lo stesso nome sommato sui mesi', () => {
    const spec = lineChart(months, 'expense');
    const row = (name: string, s: number) => spec.series[s].values[spec.labels.indexOf(name)];
    expect(row('Spesa', 0)).toBe(60000);
    expect(row('Spesa', 1)).toBe(60000);
    expect(spec.labels).not.toContain('Stipendio');
    expect(spec.series[1].values.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(111000);
  });

  it('le entrate (righe senza secchio) hanno il loro grafico', () => {
    const spec = lineChart(months, 'income');
    expect(spec.labels).toEqual(['Stipendio']);
    expect(spec.series[1].values).toEqual([210000]);
  });

  it('ordina per scostamento e somma il resto in "Altre", senza perdere il totale', () => {
    const lines = [...Array(5).keys()].map((i) => line(`Riga ${i}`, 'fun', 0, -(i + 1) * 100));
    const spec = lineChart([month('2026-09-01', lines)], 'expense', 2);
    expect(spec.labels).toEqual(['Riga 4', 'Riga 3', 'Altre (3)']);
    expect(spec.series[1].values).toEqual([500, 400, 600]);
    expect(spec.summary).toContain('Effettivo 15,00');
    expect(spec.summary).toContain('Riga 4');
  });

  it('senza movimenti né previsioni non disegna nulla', () => {
    expect(lineChart([], 'expense').labels).toEqual([]);
  });
});

describe('ripartizione nei secchi', () => {
  const pct = (fm: number | null, fun: number | null) => [
    { bucket_id: 'fm', target_pct: 15, forecast_pct: null, actual_pct: fm },
    { bucket_id: 'fun', target_pct: 35, forecast_pct: null, actual_pct: fun },
  ];

  it('mostra le percentuali della vista mese e gli obiettivi cumulati', () => {
    const spec = bucketChart([month('2026-09-01', [], { buckets: pct(10, 30.5) }), month('2026-10-01', [], { buckets: pct(null, null) })], buckets);
    expect(spec.series.map((s) => s.values)).toEqual([
      [10, null],
      [30.5, null],
    ]);
    expect(spec.ticks).toEqual([0, 15, 50]);
    // L'ultimo mese con le entrate, non l'ultimo del periodo.
    expect(spec.summary).toContain('Settembre 2026: Future me 10%, Fun 30,5%');
  });

  it('il riepilogo salta il mese appena iniziato, ancora a zero', () => {
    const spec = bucketChart([month('2026-09-01', [], { buckets: pct(10, 30) }), month('2026-10-01', [], { buckets: pct(0, 0) })], buckets);
    expect(spec.series[0].values).toEqual([10, 0]);
    expect(spec.summary).toContain('Settembre 2026: Future me 10%, Fun 30%');
  });

  it('senza entrate lo dice, invece di dividere per zero', () => {
    const spec = bucketChart([month('2026-10-01', [], { buckets: pct(null, null) })], buckets);
    expect(spec.labels).toEqual([]);
    expect(spec.summary).toContain('Nessuna entrata');
  });

  it('un periodo tutto futuro non parla di entrate', () => {
    expect(bucketChart([], buckets).summary).toBe('Nessun dato nel periodo.');
  });
});

it('top esercenti: una sola serie, senza legenda', () => {
  const spec = merchantChart([{ name: 'Il Bar', cents: 1300 }]);
  expect(spec.series).toHaveLength(1);
  expect(spec.summary).toContain('Il Bar');
  expect(merchantChart([]).labels).toEqual([]);
});

describe('torta delle uscite', () => {
  const pieBuckets = [
    { id: 'fm', name: 'Future me' },
    { id: 'fund', name: 'Fundamentals' },
    { id: 'fun', name: 'Fun' },
  ] as Bucket[];
  const row = (bucket_id: string | null, line: string | null, merchant: string | null, cents: number) => ({ bucket_id, line, merchant, cents });
  const rows = [
    row('fund', 'Affitto', null, 45000),
    row('fund', 'Luce', 'LUCE SPA', 3000),
    row('fund', 'Luce', 'ACQUA SPA', 1000),
    row('fun', 'Benzina', 'DISTRIBUTORE', 5000),
    row('fun', 'Benzina', null, 2000),
    row(null, null, 'SCONOSCIUTO', 700),
    row(null, null, null, 300),
  ];
  const tree = spendingTree(rows, pieBuckets);
  const child = (key: string) => tree.children.find((n) => n.key === key)!;

  it('il totale è quello delle righe, e i livelli lo conservano', () => {
    expect(tree.cents).toBe(57000);
    expect(tree.children.reduce((s, n) => s + n.cents, 0)).toBe(57000);
  });

  it('in cima i secchi, nel loro ordine e con il loro colore; poi "Da assegnare"', () => {
    expect(tree.children.map((n) => n.label)).toEqual(['Fundamentals', 'Fun', 'Da assegnare']);
    expect(tree.children.map((n) => n.slot)).toEqual([2, 3, 0]);
  });

  it('un secchio si apre nelle righe, una riga negli esercenti', () => {
    expect(child('fund').children.map((n) => [n.label, n.cents])).toEqual([
      ['Affitto', 45000],
      ['Luce', 4000],
    ]);
    expect(child('fund').children[1].children.map((n) => n.label)).toEqual(['LUCE SPA', 'ACQUA SPA']);
  });

  it('una riga con soli movimenti senza esercente non si apre', () => {
    expect(child('fund').children[0].children).toEqual([]);
  });

  it('con una sola riga apribile si passa direttamente agli esercenti, compresi quelli senza nome', () => {
    expect(child('fun').children.map((n) => n.label)).toEqual(['DISTRIBUTORE', 'Senza esercente']);
  });

  it('"Da assegnare" si apre negli esercenti', () => {
    expect(child('da-assegnare').children.map((n) => n.label)).toEqual(['SCONOSCIUTO', 'Senza esercente']);
  });

  it('oltre sei fette, la sesta raccoglie il resto e si apre a sua volta: nessun euro si perde', () => {
    const many = [...Array(14).keys()].map((i) => row('fund', 'Luce', `E${i}`, 1000 - i));
    const luce = spendingTree(many, pieBuckets).children[0];
    expect(luce.children).toHaveLength(6);
    const others = luce.children[5];
    expect(others.key).toBe('altri');
    expect(others.slot).toBe(0);
    expect(others.label).toBe('Altri (9)');
    expect(others.children).toHaveLength(6);
    expect(others.children[5].label).toBe('Altri (4)');
    expect(luce.children.reduce((s, n) => s + n.cents, 0)).toBe(luce.cents);
    expect(others.children[0].slot).toBe(1);
  });

  it('un periodo senza uscite è vuoto', () => {
    expect(spendingTree([], pieBuckets).children).toEqual([]);
  });
});
