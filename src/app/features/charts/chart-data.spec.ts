import { Bucket, MonthLine } from '../../core/supabase';
import {
  bucketChart,
  ChartMonth,
  clampRange,
  compareChart,
  compareDay,
  dailyChart,
  daySpending,
  lineChart,
  lineNames,
  marginChart,
  merchantChart,
  monthRow,
  periodOptions,
  periodRange,
  prune,
  savingsChart,
  spendingTree,
  topGaps,
  topMerchants,
  withoutLines,
} from './chart-data';

const buckets = [
  { id: 'fm', name: 'Future me', target_pct: 15 },
  { id: 'fun', name: 'Fun', target_pct: 35 },
] as Bucket[];

const line = (name: string, bucket_id: string | null, forecast: number, actual: number): MonthLine => ({
  id: name,
  name,
  bucket_id,
  sort_order: 0,
  over_is_good: false,
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
    expect(periodRange('f12', '2026-11-01', '2026-09-01')).toEqual({ from: '2026-11-01', to: '2027-10-01' });
    expect(periodRange('m6', '2026-11-01', null)).toEqual({ from: '2026-06-01', to: '2026-11-01' });
  });

  it('propone gli anni dall\'avvio al prossimo', () => {
    expect(periodOptions('2027-02-01', '2026-09-01').map((o) => o.value)).toEqual(['y2026', 'y2027', 'y2028', 'm1', 'p1', 'm3', 'm6', 'm12', 'f12']);
    expect(periodOptions('2026-11-01', null).map((o) => o.value)).toEqual(['y2026', 'y2027', 'm1', 'p1', 'm3', 'm6', 'm12', 'f12']);
  });

  it('questo mese e mese scorso sono un mese solo', () => {
    expect(periodRange('m1', '2026-11-01', '2026-09-01')).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(periodRange('p1', '2026-11-01', '2026-09-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    // Il mese scorso prima dell'avvio non esiste: resta il mese di avvio.
    expect(periodRange('p1', '2026-09-01', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-09-01' });
  });

  it("un periodo scritto a mano: nell'ordine giusto, dall'avvio, al massimo tre anni", () => {
    expect(clampRange('2026-12-01', '2026-10-01', null)).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(clampRange('2026-01-01', '2026-10-01', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-10-01' });
    expect(clampRange('2026-01-01', '2030-01-01', null)).toEqual({ from: '2026-01-01', to: '2028-12-01' });
  });
});

describe('margine del mese', () => {
  it('effettivo per i mesi chiusi, previsto dal mese in corso; trova il mese più stretto', () => {
    const months = [
      // Come nel database: uscite e accantonamenti negativi; i movimenti da assegnare contano nell'effettivo.
      month('2026-10-01', [], {
        income_actual: 2000,
        expense_actual: -1500,
        saving_actual: -100,
        unassigned: { actual: -50, n: 1 },
        income_forecast: 2000,
        expense_forecast: -1000,
      }),
      month('2026-11-01', [], { income_forecast: 2000, expense_forecast: -1800, saving_forecast: -100 }),
      month('2026-12-01', [], { income_forecast: 2000, expense_forecast: -2600, saving_forecast: -100 }),
    ];
    const spec = marginChart(months, '2026-11-01');
    expect(spec.series[0].values).toEqual([350, null, null]);
    expect(spec.series[1].values).toEqual([null, 100, -700]);
    expect(spec.summary).toContain('toglie');
    expect(spec.summary).toContain('dicembre 2026');
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

describe('righe scelte per un grafico', () => {
  const months = [
    month('2026-10-01', [line('Stipendio', null, 200000, 200000), line('Spesa', 'fun', -30000, -40000), line('Cinema', 'fun', -5000, -10000), line('Casa', 'fm', -50000, -50000)], {
      income_actual: 200000,
      buckets: [
        { bucket_id: 'fm', target_pct: 15, forecast_pct: 25, actual_pct: 25 },
        { bucket_id: 'fun', target_pct: 35, forecast_pct: 17.5, actual_pct: 25 },
      ],
    }),
  ];

  it('senza esclusioni restano i numeri del database', () => {
    expect(withoutLines(months, new Set())).toBe(months);
  });

  it('una riga esclusa esce dai grafici, e il suo secchio si ricalcola sulle entrate', () => {
    const [m] = withoutLines(months, new Set(['Cinema']));
    expect(m.lines.map((l) => l.name)).toEqual(['Stipendio', 'Spesa', 'Casa']);
    expect(m.buckets.map((b) => b.actual_pct)).toEqual([25, 20]);
    expect(lineChart([m], 'expense').labels).not.toContain('Cinema');
  });

  it('propone le righe dei secchi, oppure le entrate, in ordine alfabetico', () => {
    expect(lineNames(months, 'expense')).toEqual(['Casa', 'Cinema', 'Spesa']);
    expect(lineNames(months, 'income')).toEqual(['Stipendio']);
  });

  it('gli esercenti si sommano dalle uscite per riga; senza nome e rimborsi netti restano fuori', () => {
    const row = (name: string, merchant: string | null, cents: number) => ({ bucket_id: 'fun', line: name, merchant, cents });
    const rows = [row('Spesa', 'Il Bar', 500), row('Cinema', 'Il Bar', 300), row('Spesa', 'Lidl', 2000), row('Spesa', null, 900), row('Spesa', 'Reso', -100)];
    expect(topMerchants(rows)).toEqual([
      { name: 'Lidl', cents: 2000 },
      { name: 'Il Bar', cents: 800 },
    ]);
  });
});

describe('uscite giorno per giorno', () => {
  const tx = (booking_date: string, amount_cents: number, bucket_id: string | null | undefined, transfer_group_id: string | null = null) => ({
    booking_date,
    amount_cents,
    line_id: bucket_id === undefined ? null : 'l',
    transfer_group_id,
    budget_lines: bucket_id === undefined ? null : { name: bucket_id ? 'Spesa' : 'Stipendio', bucket_id },
  });
  const rows = daySpending([
    tx('2026-10-05', -1000, 'fun'),
    tx('2026-10-20', -3000, 'fun'),
    tx('2026-10-28', -9000, 'fm'),
    tx('2026-11-03', -2000, 'fun'),
    tx('2026-11-03', 500, 'fun'),
    tx('2026-11-10', -700, undefined),
    // Fuori: un'entrata, un'entrata da assegnare, un trasferimento senza riga.
    tx('2026-11-04', 200000, null),
    tx('2026-11-05', 4000, undefined),
    tx('2026-11-06', -5000, undefined, 'g'),
  ]);

  it('conta le righe dei secchi e le uscite da assegnare, come la torta; un rimborso compensa', () => {
    expect(rows.filter((r) => r.date.startsWith('2026-11')).map((r) => r.cents)).toEqual([2000, -500, 700]);
  });

  it('confronta due mesi fino allo stesso giorno, per secchio e in totale', () => {
    expect(compareDay('2026-11-01', '2026-11-22')).toBe(22);
    expect(compareDay('2026-10-01', '2026-11-22')).toBe(31);
    const spec = compareChart(rows, '2026-11-01', '2026-10-01', 22, buckets);
    expect(spec.form).toBe('vbars');
    expect(spec.labels).toEqual(['Fun', 'Da assegnare', 'Totale']);
    // Ottobre si ferma al 22: la spesa del 28 non conta, e il suo secchio non compare.
    expect(spec.series.map((s) => s.values)).toEqual([
      [1500, 700, 2200],
      [4000, 0, 4000],
    ]);
    expect(spec.summary).toContain('in meno');
  });

  it('lo stesso mese due volte ha una serie sola', () => {
    expect(compareChart(rows, '2026-10-01', '2026-10-01', 31, buckets).series).toHaveLength(1);
  });

  it('una colonna per giorno e la cumulata tratteggiata, che si ferma a oggi', () => {
    const spec = dailyChart(rows, '2026-11-01', '2026-11-12');
    const [perDay, total] = spec.series;
    expect(spec.labels).toHaveLength(30);
    expect(perDay.values.slice(0, 12)).toEqual([0, 0, 1500, 0, 0, 0, 0, 0, 0, 700, 0, 0]);
    expect(perDay.values[12]).toBeNull();
    expect([total.line, total.dashed]).toEqual([true, true]);
    expect([total.values[2], total.values[11], total.values[12]]).toEqual([1500, 2200, null]);
    expect(spec.summary).toContain('Il giorno più caro: il 3');
  });

  it('un mese senza uscite non disegna nulla', () => {
    expect(dailyChart(rows, '2026-09-01', '2026-11-12').labels).toEqual([]);
  });
});

it('torta: una fetta tolta a mano esce anche dai totali sopra, solo nel suo ramo', () => {
  const row = (bucket_id: string, name: string, merchant: string, cents: number) => ({ bucket_id, line: name, merchant, cents });
  const tree = spendingTree([row('fm', 'Luce', 'A', 3000), row('fm', 'Luce', 'B', 1000), row('fm', 'Gas', 'A', 500), row('fun', 'Bar', 'A', 200)], buckets);
  const cut = prune(tree, new Set(['fm>fm/Luce>A']));
  const fm = cut.children.find((n) => n.key === 'fm')!;
  expect(cut.cents).toBe(1700);
  expect(fm.cents).toBe(1500);
  expect(fm.children.find((n) => n.key === 'fm/Luce')!.children.map((n) => n.label)).toEqual(['B']);
  expect(prune(tree, new Set(['fm'])).children.map((n) => n.key)).toEqual(['fun']);
});

describe('riepilogo dei mesi', () => {
  const m = month('2026-12-01', [line('Spesa', 'fun', -30000, -45000), line('Casa', 'fm', -50000, -50000), line('Luce', 'fm', -6000, -5000)], {
    income_forecast: 2000,
    income_actual: 500,
    expense_forecast: -1500,
    expense_actual: -300,
    end_forecast: 900,
    end_actual: 600,
    reserve_forecast: 4000,
    reserve_actual: 3900,
  });

  it('effettivo fino al mese in corso, previsto per i futuri; il Salvadanaio segue le righe', () => {
    expect(monthRow(m, '2026-12-01')).toEqual({ month: '2026-12-01', income: 500, expense: -300, end: 600, reserve: 4000 });
    expect(monthRow(m, '2026-11-01')).toEqual({ month: '2026-12-01', income: 2000, expense: -1500, end: 900, reserve: 4000 });
  });

  it('le righe con lo scostamento maggiore, senza quelle in linea', () => {
    expect(topGaps(m).map((l) => l.name)).toEqual(['Spesa', 'Luce']);
  });
});
