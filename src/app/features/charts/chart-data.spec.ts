import { Bucket, Category, MonthLine } from '../../core/supabase';
import { bucketChart, categoryChart, ChartData, ChartMonth, merchantChart, periodOptions, periodRange, recurringChart, savingsChart, spendingTree } from './chart-data';

const cat = (id: string, name: string, kind: string) => ({ id, name, kind }) as Category;
const categories = new Map(
  [cat('stip', 'Stipendio', 'income'), cat('ris', 'Risparmio', 'saving'), cat('spesa', 'Spesa', 'expense'), cat('casa', 'Casa', 'expense')].map((c) => [c.id, c]),
);
const buckets = [
  { id: 'fm', name: 'Future me', target_pct: 15 },
  { id: 'fun', name: 'Fun', target_pct: 35 },
] as Bucket[];

const line = (category_id: string | null, forecast: number | null, actual: number, inflow: boolean | null = null): MonthLine => ({
  category_id,
  bucket_id: null,
  inflow,
  forecast,
  actual,
  n: 1,
  is_default: false,
});

function month(key: string, lines: MonthLine[], extra: Partial<ChartMonth> = {}): ChartMonth {
  return {
    month: key,
    lines,
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

describe('previsto ed effettivo per categoria', () => {
  const months = [
    month('2026-09-01', [line('stip', 200000, 210000), line('spesa', -30000, -40000), line('casa', -50000, -50000), line(null, null, -700, false), line(null, null, 900, true), line('ris', -5000, -5000)]),
    month('2026-10-01', [line('spesa', -30000, -20000), line('casa', null, -1000)]),
  ];

  it('le uscite sommano come expense_actual e expense_forecast: dentro anche "Da assegnare", fuori risparmio ed entrate', () => {
    const spec = categoryChart(months, categories, 'expense');
    const row = (name: string, s: number) => spec.series[s].values[spec.labels.indexOf(name)];
    expect(row('Spesa', 0)).toBe(60000);
    expect(row('Spesa', 1)).toBe(60000);
    expect(row('Da assegnare', 1)).toBe(700);
    expect(spec.labels).not.toContain('Risparmio');
    expect(spec.labels).not.toContain('Stipendio');
    expect(spec.series[1].values.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(111700);
  });

  it('le entrate hanno il loro grafico, comprese quelle da assegnare', () => {
    const spec = categoryChart(months, categories, 'income');
    expect(spec.labels).toEqual(['Stipendio', 'Da assegnare']);
    expect(spec.series[1].values).toEqual([210000, 900]);
  });

  it('ordina per scostamento e somma il resto in "Altre", senza perdere il totale', () => {
    const many = new Map([...Array(5).keys()].map((i) => [`c${i}`, cat(`c${i}`, `Cat ${i}`, 'expense')]));
    const lines = [...Array(5).keys()].map((i) => line(`c${i}`, 0, -(i + 1) * 100));
    const spec = categoryChart([month('2026-09-01', lines)], many, 'expense', 2);
    expect(spec.labels).toEqual(['Cat 4', 'Cat 3', 'Altre (3)']);
    expect(spec.series[1].values).toEqual([500, 400, 600]);
    expect(spec.summary).toContain('Effettivo 15,00');
    expect(spec.summary).toContain('Cat 4');
  });

  it('senza movimenti né previsioni non disegna nulla', () => {
    expect(categoryChart([], categories, 'expense').labels).toEqual([]);
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
    // L'ultimo mese con lo stipendio, non l'ultimo del periodo.
    expect(spec.summary).toContain('Settembre 2026: Future me 10%, Fun 30,5%');
  });

  it('il riepilogo salta il mese appena iniziato, ancora a zero', () => {
    const spec = bucketChart([month('2026-09-01', [], { buckets: pct(10, 30) }), month('2026-10-01', [], { buckets: pct(0, 0) })], buckets);
    expect(spec.series[0].values).toEqual([10, 0]);
    expect(spec.summary).toContain('Settembre 2026: Future me 10%, Fun 30%');
  });

  it('senza stipendio lo dice, invece di dividere per zero', () => {
    const spec = bucketChart([month('2026-10-01', [], { buckets: pct(null, null) })], buckets);
    expect(spec.labels).toEqual([]);
    expect(spec.summary).toContain('Nessuno stipendio');
  });

  it('un periodo tutto futuro non parla di stipendio', () => {
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
  const expense = (id: string, name: string, sort_order: number, super_category: string | null) => ({ id, name, kind: 'expense', sort_order, super_category }) as Category;
  const cats = new Map(
    [
      expense('aff', 'Affitto', 1, 'Casa'),
      expense('ute', 'Utenze', 2, 'Casa'),
      expense('car', 'Carburante', 3, 'Spostamenti'),
      expense('mus', 'Musica', 4, null),
      cat('stip', 'Stipendio', 'income'),
    ].map((c) => [c.id, c]),
  );
  const row = (category_id: string | null, merchant: string | null, cents: number) => ({ category_id, merchant, cents });
  const rows = [
    row('aff', null, 45000),
    row('ute', 'LUCE SPA', 3000),
    row('ute', 'ACQUA SPA', 1000),
    row('car', 'DISTRIBUTORE', 5000),
    row('car', null, 2000),
    row('mus', 'NEGOZIO DISCHI', 8000),
    row(null, 'SCONOSCIUTO', 700),
    row(null, null, 300),
  ];
  const tree = spendingTree(rows, cats);
  const child = (key: string) => tree.children.find((n) => n.key === key)!;

  it('il totale è quello delle righe, e i livelli lo conservano', () => {
    expect(tree.cents).toBe(65000);
    expect(tree.children.reduce((s, n) => s + n.cents, 0)).toBe(65000);
  });

  it('in cima le super categorie, nell\'ordine delle categorie; senza super categoria vale "Altro"; poi "Da assegnare"', () => {
    expect(tree.children.map((n) => n.label)).toEqual(['Casa', 'Spostamenti', 'Altro', 'Da assegnare']);
    expect(tree.children.map((n) => n.slot)).toEqual([1, 2, 3, 0]);
  });

  it('una super categoria si apre nelle categorie, una categoria negli esercenti', () => {
    expect(child('Casa').children.map((n) => [n.label, n.cents])).toEqual([
      ['Affitto', 45000],
      ['Utenze', 4000],
    ]);
    expect(child('Casa').children[1].children.map((n) => n.label)).toEqual(['LUCE SPA', 'ACQUA SPA']);
  });

  it('una categoria con soli movimenti senza esercente non si apre', () => {
    expect(child('Casa').children[0].children).toEqual([]);
  });

  it('i movimenti senza esercente restano come fetta accanto agli altri', () => {
    expect(child('Spostamenti').children.map((n) => n.label)).toEqual(['DISTRIBUTORE', 'Senza esercente']);
  });

  it('con una sola categoria apribile si passa direttamente agli esercenti', () => {
    // Spostamenti ha solo Carburante, Altro solo Musica.
    expect(child('Altro').children.map((n) => n.label)).toEqual(['NEGOZIO DISCHI']);
  });

  it('"Da assegnare" si apre negli esercenti', () => {
    expect(child('da-assegnare').children.map((n) => n.label)).toEqual(['SCONOSCIUTO', 'Senza esercente']);
  });

  it('oltre sei fette, la sesta raccoglie il resto e si apre a sua volta: nessun euro si perde', () => {
    const many = [...Array(14).keys()].map((i) => row('ute', `E${i}`, 1000 - i));
    const utenze = spendingTree(many, cats).children[0];
    expect(utenze.children).toHaveLength(6);
    const others = utenze.children[5];
    expect(others.key).toBe('altri');
    expect(others.slot).toBe(0);
    expect(others.label).toBe('Altri (9)');
    expect(others.children).toHaveLength(6);
    expect(others.children[5].label).toBe('Altri (4)');
    expect(utenze.children.reduce((s, n) => s + n.cents, 0)).toBe(utenze.cents);
    expect(others.children[0].slot).toBe(1);
  });

  it('il colore di una super categoria non cambia se in un periodo un\'altra manca', () => {
    const noHouse = spendingTree([row('car', 'DISTRIBUTORE', 5000)], cats);
    expect(noHouse.children.map((n) => [n.label, n.slot])).toEqual([['Spostamenti', 2]]);
  });

  it('un periodo senza uscite è vuoto', () => {
    expect(spendingTree([], cats).children).toEqual([]);
  });
});

describe('ricorrenti', () => {
  const rule = (name: string, yearly: number, active: boolean, months: Record<string, number>): ChartData['recurring'][number] => ({ name, yearly, active, months });
  const months = [month('2026-10-01', []), month('2026-11-01', [])];

  it('una serie per ricorrente; il totale annuo conta solo quelle attive', () => {
    const spec = recurringChart([rule('A', 12000, true, { '2026-10-01': 1000, '2026-11-01': 1100 }), rule('Finita', 50000, false, { '2026-10-01': 500 })], months);
    expect(spec.series[0]).toEqual({ label: 'A', slot: 1, values: [1000, 1100] });
    expect(spec.summary).toContain('120,00');
  });

  it('i colori seguono la ricorrente anche se un\'altra sparisce dal periodo', () => {
    const spec = recurringChart([rule('Senza mesi', 90000, true, {}), rule('B', 12000, true, { '2026-11-01': 1000 })], months);
    expect(spec.series).toEqual([{ label: 'B', slot: 2, values: [0, 1000] }]);
  });

  it('oltre le sette più care, una sola serie "Altre" grigia', () => {
    const rules = [...Array(9).keys()].map((i) => rule(`R${i}`, 900 - i, true, { '2026-10-01': 100 }));
    const spec = recurringChart(rules, months);
    expect(spec.series).toHaveLength(8);
    expect(spec.series[7]).toEqual({ label: 'Altre', slot: 0, values: [200, 0] });
  });

  it('senza scadenze nel periodo non disegna, ma il totale annuo resta', () => {
    const spec = recurringChart([rule('A', 12000, true, {})], months);
    expect(spec.labels).toEqual([]);
    expect(spec.summary).toContain('120,00');
  });
});
