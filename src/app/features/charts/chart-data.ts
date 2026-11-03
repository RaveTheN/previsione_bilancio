import { monthLabel, shiftMonth } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { Bucket, Category, MonthOverview } from '../../core/supabase';

/** Forma (jsonb) di chart_data: è definita nella migrazione "grafici". */
export interface ChartMonth extends MonthOverview {
  month: string;
}

export interface ChartData {
  months: ChartMonth[];
  merchants: { name: string; cents: number }[];
  recurring: { name: string; yearly: number; active: boolean; months: Record<string, number> }[];
}

export interface Series {
  label: string;
  values: (number | null)[];
  /** Posizione nella palette: 1-7 identità, 0 grigio (previsione, "Altre"). Segue l'entità, non la classifica. */
  slot: number;
  dashed?: boolean;
}

export interface ChartSpec {
  /** Colonne impilate, linee o barre orizzontali raggruppate. */
  form: 'columns' | 'line' | 'bars';
  unit: 'cents' | 'pct';
  labels: string[];
  series: Series[];
  /** Testo sotto il titolo: è anche il testo alternativo del grafico. */
  summary: string;
  /** Linee orizzontali esatte, per gli obiettivi; altrimenti scelte da Chart.js. */
  ticks?: number[];
}

const empty = (summary = 'Nessun dato nel periodo.'): ChartSpec => ({ form: 'bars', unit: 'cents', labels: [], series: [], summary });

const shortMonth = (month: string) => new Date(month + 'T12:00:00').toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });

export const formatPct = (value: number) => `${value.toLocaleString('it-IT', { maximumFractionDigits: 1 })}%`;

/** Mesi inclusi di un periodo ("m6", "m12" = ultimi mesi; "y2026" = anno), mai prima del mese di avvio. */
export function periodRange(period: string, current: string, goLive: string | null): { from: string; to: string } {
  const n = Number(period.slice(1));
  const from = period[0] === 'y' ? `${n}-01-01` : shiftMonth(current, 1 - n);
  const to = period[0] === 'y' ? `${n}-12-01` : current;
  return { from: goLive && goLive > from ? goLive : from, to };
}

export function periodOptions(current: string, goLive: string | null): { value: string; label: string }[] {
  const thisYear = Number(current.slice(0, 4));
  const years = [];
  for (let y = Math.min(Number((goLive ?? current).slice(0, 4)), thisYear); y <= thisYear + 1; y++) years.push(y);
  return [
    ...years.map((y) => ({ value: `y${y}`, label: `Anno ${y}` })),
    { value: 'm6', label: 'Ultimi 6 mesi' },
    { value: 'm12', label: 'Ultimi 12 mesi' },
  ];
}

/** Il Salvadanaio: l'effettivo fino a oggi, la previsione su tutto il periodo. */
export function savingsChart(months: ChartMonth[], current: string): ChartSpec {
  if (!months.some((m) => m.reserve_forecast !== null)) return empty('Nessun conto di riserva nel periodo.');
  const now = months.filter((m) => m.month <= current).at(-1);
  const last = months[months.length - 1];
  const parts = [
    now && now.reserve_actual !== null ? `Salvadanaio a ${monthLabel(now.month).toLowerCase()}: ${formatCents(now.reserve_actual)}.` : '',
    last.month > current && last.reserve_forecast !== null ? `Previsto a ${monthLabel(last.month).toLowerCase()}: ${formatCents(last.reserve_forecast)}.` : '',
  ];
  return {
    form: 'line',
    unit: 'cents',
    labels: months.map((m) => shortMonth(m.month)),
    series: [
      { label: 'Effettivo', slot: 1, values: months.map((m) => (m.month <= current ? m.reserve_actual : null)) },
      { label: 'Previsto', slot: 0, dashed: true, values: months.map((m) => m.reserve_forecast) },
    ].filter((s) => s.values.some((v) => v !== null)),
    summary: parts.filter(Boolean).join(' '),
  };
}

/**
 * Previsto ed effettivo sul periodo, per categoria, dal maggiore scostamento: gli altri si
 * sommano in "Altre", così il totale resta quello della vista mese.
 */
export function categoryChart(months: ChartMonth[], categories: Map<string, Category>, kind: 'income' | 'expense', limit = 10): ChartSpec {
  const sign = kind === 'income' ? 1 : -1;
  const rows = new Map<string, { forecast: number; actual: number }>();
  for (const month of months) {
    for (const line of month.lines) {
      const cat = line.category_id ? categories.get(line.category_id) : undefined;
      if ((cat?.kind ?? (line.inflow ? 'income' : 'expense')) !== kind) continue;
      const name = cat?.name ?? 'Da assegnare';
      const row = rows.get(name) ?? { forecast: 0, actual: 0 };
      row.forecast += sign * (line.forecast ?? 0);
      row.actual += sign * line.actual;
      rows.set(name, row);
    }
  }
  const gap = (r: { forecast: number; actual: number }) => Math.abs(r.actual - r.forecast);
  const sorted = [...rows].filter(([, r]) => r.forecast || r.actual).sort((a, b) => gap(b[1]) - gap(a[1]));
  if (!sorted.length) return empty();

  const shown = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  if (rest.length) {
    const sum = (key: 'forecast' | 'actual') => rest.reduce((s, [, r]) => s + r[key], 0);
    shown.push([`Altre (${rest.length})`, { forecast: sum('forecast'), actual: sum('actual') }]);
  }
  const total = (key: 'forecast' | 'actual') => sorted.reduce((s, [, r]) => s + r[key], 0);
  const [topName, top] = sorted[0];
  return {
    form: 'bars',
    unit: 'cents',
    labels: shown.map(([name]) => name),
    series: [
      { label: 'Previsto', slot: 0, values: shown.map(([, r]) => r.forecast) },
      { label: 'Effettivo', slot: 1, values: shown.map(([, r]) => r.actual) },
    ],
    summary:
      `Effettivo ${formatCents(total('actual'))} su ${formatCents(total('forecast'))} previsti. ` +
      `Scostamento maggiore: ${topName}, ${top.actual > top.forecast ? 'più' : 'meno'} ${formatCents(gap(top))} del previsto.`,
  };
}

/**
 * Le percentuali della vista mese, impilate: la base è lo stipendio, non il totale speso, quindi
 * la colonna arriva a 100 solo se si spende tutto. Le linee orizzontali sono gli obiettivi cumulati.
 * shortcut: obiettivi attuali anche per i mesi passati, come nella vista mese; se cambiano spesso, serve il loro storico.
 */
export function bucketChart(months: ChartMonth[], buckets: Bucket[]): ChartSpec {
  if (!months.length) return empty();
  const pct = (m: ChartMonth, id: string) => m.buckets.find((b) => b.bucket_id === id)?.actual_pct ?? null;
  const withSalary = months.filter((m) => buckets.some((b) => pct(m, b.id) !== null));
  if (!withSalary.length) return empty('Nessuno stipendio nel periodo: le percentuali non si calcolano.');
  // L'ultimo mese con delle spese: uno appena iniziato direbbe solo 0%.
  const last = withSalary.filter((m) => buckets.some((b) => pct(m, b.id))).at(-1) ?? withSalary[withSalary.length - 1];
  let sum = 0;
  const ticks = [0, ...buckets.map((b) => (sum += b.target_pct))];
  const list = (value: (b: Bucket) => number | null) => buckets.map((b) => `${b.name} ${value(b) === null ? '—' : formatPct(value(b) as number)}`).join(', ');
  return {
    form: 'columns',
    unit: 'pct',
    labels: months.map((m) => shortMonth(m.month)),
    series: buckets.map((b, i) => ({ label: b.name, slot: i + 1, values: months.map((m) => pct(m, b.id)) })),
    summary: `Sullo stipendio, con gli obiettivi come linee: ${list((b) => b.target_pct)}. ${monthLabel(last.month)}: ${list((b) => pct(last, b.id))}.`,
    ticks,
  };
}

export function merchantChart(merchants: ChartData['merchants']): ChartSpec {
  if (!merchants.length) return empty();
  return {
    form: 'bars',
    unit: 'cents',
    labels: merchants.map((m) => m.name),
    series: [{ label: 'Speso', slot: 1, values: merchants.map((m) => m.cents) }],
    summary: `Al primo posto ${merchants[0].name}, con ${formatCents(merchants[0].cents)}.`,
  };
}

/** Costo mese per mese delle ricorrenti: le sette più care all'anno, le altre insieme, così i colori non cambiano col periodo. */
export function recurringChart(recurring: ChartData['recurring'], months: ChartMonth[]): ChartSpec {
  const yearly = recurring.filter((r) => r.active).reduce((s, r) => s + r.yearly, 0);
  const summary = `Costo annuo delle ricorrenti attive: ${formatCents(yearly)}.`;
  const values = (rules: ChartData['recurring']) => months.map((m) => rules.reduce((s, r) => s + (r.months[m.month] ?? 0), 0));
  const series: Series[] = recurring.slice(0, 7).map((r, i) => ({ label: r.name, slot: i + 1, values: values([r]) }));
  if (recurring.length > 7) series.push({ label: 'Altre', slot: 0, values: values(recurring.slice(7)) });
  const shown = series.filter((s) => s.values.some(Boolean));
  if (!shown.length) return { ...empty(), summary: `Nessuna ricorrente nel periodo. ${summary}` };
  return {
    form: 'columns',
    unit: 'cents',
    labels: months.map((m) => shortMonth(m.month)),
    series: shown,
    summary: `${summary} I mesi futuri sono previsti.`,
  };
}
