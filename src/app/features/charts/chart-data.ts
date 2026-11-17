import { monthLabel, shiftMonth } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { lineKind } from '../../core/budget';
import { Bucket, MonthOverview } from '../../core/supabase';

/** Forma (jsonb) di chart_data: è definita nella migrazione "righe_libere". */
export interface ChartMonth extends MonthOverview {
  month: string;
}

export interface ChartData {
  months: ChartMonth[];
  merchants: { name: string; cents: number }[];
  /** Uscite del periodo per secchio, riga ed esercente; senza secchio quelle da assegnare. */
  spending: { bucket_id: string | null; line: string | null; merchant: string | null; cents: number }[];
}

/** Una fetta della torta: se ha figli, toccandola si apre nelle sue parti. */
export interface PieNode {
  key: string;
  label: string;
  cents: number;
  /** Posizione nella palette, come in Series. */
  slot: number;
  children: PieNode[];
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
  // "f12": i prossimi mesi, a partire da quello in corso.
  const from = period[0] === 'y' ? `${n}-01-01` : period[0] === 'f' ? current : shiftMonth(current, 1 - n);
  const to = period[0] === 'y' ? `${n}-12-01` : period[0] === 'f' ? shiftMonth(current, n - 1) : current;
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
    { value: 'f12', label: 'Prossimi 12 mesi' },
  ];
}

/** Un saldo nel tempo: l'effettivo fino a oggi, la previsione su tutto il periodo (anche i mesi futuri). */
function trendChart(
  months: ChartMonth[],
  current: string,
  name: string,
  actual: (m: ChartMonth) => number | null,
  forecast: (m: ChartMonth) => number | null,
  emptyText: string,
): ChartSpec {
  if (!months.some((m) => forecast(m) !== null)) return empty(emptyText);
  const now = months.filter((m) => m.month <= current).at(-1);
  const last = months[months.length - 1];
  const [nowValue, lastValue] = [now ? actual(now) : null, forecast(last)];
  const parts = [
    now && nowValue !== null ? `${name} a ${monthLabel(now.month).toLowerCase()}: ${formatCents(nowValue)}.` : '',
    last.month > current && lastValue !== null ? `Previsto a ${monthLabel(last.month).toLowerCase()}: ${formatCents(lastValue)}.` : '',
  ];
  return {
    form: 'line',
    unit: 'cents',
    labels: months.map((m) => shortMonth(m.month)),
    series: [
      { label: 'Effettivo', slot: 1, values: months.map((m) => (m.month <= current ? actual(m) : null)) },
      { label: 'Previsto', slot: 0, dashed: true, values: months.map(forecast) },
    ].filter((s) => s.values.some((v) => v !== null)),
    summary: parts.filter(Boolean).join(' '),
  };
}

/** Il Salvadanaio: l'effettivo fino a oggi, la previsione su tutto il periodo. */
export function savingsChart(months: ChartMonth[], current: string): ChartSpec {
  return trendChart(months, current, 'Salvadanaio', (m) => m.reserve_actual, (m) => m.reserve_forecast, 'Nessun conto di riserva nel periodo.');
}

/** Il disponibile a fine mese, come nel riepilogo della vista mese. */
export function balanceChart(months: ChartMonth[], current: string): ChartSpec {
  return trendChart(months, current, 'Disponibile', (m) => m.end_actual, (m) => m.end_forecast, 'Il disponibile non si calcola: imposta il mese di avvio.');
}

const plus = (a: number | null, b: number | null) => (a === null ? null : a + (b ?? 0));

/** Tutto quello che hai: disponibile più Salvadanaio (senza conti di riserva, solo il disponibile). */
export function totalChart(months: ChartMonth[], current: string): ChartSpec {
  return trendChart(
    months,
    current,
    'Totale',
    (m) => plus(m.end_actual, m.reserve_actual),
    (m) => plus(m.end_forecast, m.reserve_forecast),
    'Il totale non si calcola: imposta il mese di avvio.',
  );
}

/**
 * Quanto ogni mese aggiunge o toglie al disponibile: entrate meno uscite e accantonamenti.
 * I mesi chiusi con l'effettivo, quello in corso e i futuri con il previsto.
 */
export function marginChart(months: ChartMonth[], current: string): ChartSpec {
  if (!months.length) return empty();
  const margin = (m: ChartMonth, k: 'forecast' | 'actual') => m[`income_${k}`] + m[`expense_${k}`] - m[`saving_${k}`];
  const planned = months.filter((m) => m.month >= current);
  const worst = planned.length ? planned.reduce((a, b) => (margin(b, 'forecast') < margin(a, 'forecast') ? b : a)) : null;
  const sum = planned.reduce((s, m) => s + margin(m, 'forecast'), 0);
  return {
    form: 'columns',
    unit: 'cents',
    labels: months.map((m) => shortMonth(m.month)),
    series: [
      { label: 'Effettivo', slot: 1, values: months.map((m) => (m.month < current ? margin(m, 'actual') : null)) },
      { label: 'Previsto', slot: 0, values: months.map((m) => (m.month >= current ? margin(m, 'forecast') : null)) },
    ].filter((s) => s.values.some((v) => v !== null)),
    summary: worst
      ? `Da ${monthLabel(planned[0].month).toLowerCase()} in poi il previsto ${sum < 0 ? 'toglie' : 'aggiunge'} ${formatCents(Math.abs(sum))} al disponibile. ` +
        `Il mese più stretto: ${monthLabel(worst.month).toLowerCase()}, ${formatCents(margin(worst, 'forecast'))}.`
      : 'Entrate meno uscite e accantonamenti, mese per mese.',
  };
}

/** Le rate che cadono in ogni mese, anche nei futuri: si vede quando finiscono. */
export function debtChart(months: ChartMonth[]): ChartSpec {
  const withDebt = months.filter((m) => m.debt_cents);
  if (!withDebt.length) return empty('Nessuna rata nel periodo.');
  return {
    form: 'columns',
    unit: 'cents',
    labels: months.map((m) => shortMonth(m.month)),
    series: [{ label: 'Rate', slot: 3, values: months.map((m) => m.debt_cents) }],
    summary: `Rate nel periodo: ${formatCents(withDebt.reduce((s, m) => s + m.debt_cents, 0))}. Ultimo mese con rate: ${monthLabel(withDebt.at(-1)!.month).toLowerCase()}.`,
  };
}

/**
 * Previsto ed effettivo sul periodo, per riga (lo stesso nome nei vari mesi), dal maggiore
 * scostamento: le altre si sommano in "Altre", così il totale resta quello delle righe.
 */
export function lineChart(months: ChartMonth[], kind: 'income' | 'expense', limit = 10): ChartSpec {
  const sign = kind === 'income' ? 1 : -1;
  const rows = new Map<string, { forecast: number; actual: number }>();
  for (const month of months) {
    for (const line of month.lines) {
      if (lineKind(line.bucket_id) !== kind) continue;
      const row = rows.get(line.name) ?? { forecast: 0, actual: 0 };
      row.forecast += sign * line.forecast;
      row.actual += sign * line.actual;
      rows.set(line.name, row);
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
 * Le percentuali della vista mese, impilate: la base sono le entrate, non il totale speso, quindi
 * la colonna arriva a 100 solo se si spende tutto. Le linee orizzontali sono gli obiettivi cumulati.
 * shortcut: obiettivi attuali anche per i mesi passati, come nella vista mese; se cambiano spesso, serve il loro storico.
 */
export function bucketChart(months: ChartMonth[], buckets: Bucket[]): ChartSpec {
  if (!months.length) return empty();
  const pct = (m: ChartMonth, id: string) => m.buckets.find((b) => b.bucket_id === id)?.actual_pct ?? null;
  const withSalary = months.filter((m) => buckets.some((b) => pct(m, b.id) !== null));
  if (!withSalary.length) return empty('Nessuna entrata nel periodo: le percentuali non si calcolano.');
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
    summary: `Sulle entrate, con gli obiettivi come linee: ${list((b) => b.target_pct)}. ${monthLabel(last.month)}: ${list((b) => pct(last, b.id))}.`,
    ticks,
  };
}

const MAX_SLICES = 6;
const UNASSIGNED = 'da-assegnare';
const OTHERS = 'altri';
const NO_MERCHANT = 'senza-esercente';

const sumCents = (list: { cents: number }[]) => list.reduce((s, x) => s + x.cents, 0);
const bySize = (a: { cents: number }, b: { cents: number }) => b.cents - a.cents;

/** Al massimo sei fette: oltre, la sesta raccoglie il resto e si apre a sua volta. Il colore segue la posizione. */
function fold(list: PieNode[]): PieNode[] {
  const rest = list.slice(MAX_SLICES - 1);
  const shown =
    list.length <= MAX_SLICES ? list : [...list.slice(0, MAX_SLICES - 1), { key: OTHERS, label: `Altri (${rest.length})`, cents: sumCents(rest), slot: 0, children: fold(rest) }];
  return shown.map((n, i) => ({ ...n, slot: n.key === OTHERS || n.key === UNASSIGNED ? 0 : i + 1 }));
}

/** Un livello con un solo figlio apribile non aggiunge nulla: si passa direttamente alle sue parti. */
function branch(key: string, label: string, cents: number, children: PieNode[]): PieNode {
  return { key, label, cents, slot: 0, children: fold(children.length === 1 && children[0].children.length ? children[0].children : children) };
}

function merchantLeaves(rows: ChartData['spending']): PieNode[] {
  const leaves = rows.map((r) => ({ key: r.merchant ?? NO_MERCHANT, label: r.merchant ?? 'Senza esercente', cents: r.cents, slot: 0, children: [] })).sort(bySize);
  // Solo movimenti senza esercente (es. l'affitto col bonifico): non c'è niente da aprire.
  return leaves.length === 1 && leaves[0].key === NO_MERCHANT ? [] : leaves;
}

/** Uscite del periodo: Secchio → Riga → Esercente. I secchi restano nel loro ordine e tengono il colore al cambio di periodo. */
export function spendingTree(rows: ChartData['spending'], buckets: Bucket[]): PieNode {
  const groups = buckets.map((b) => {
    const inGroup = rows.filter((r) => r.bucket_id === b.id);
    const nodes = [...new Set(inGroup.map((r) => r.line ?? ''))]
      .map((name) => {
        const own = inGroup.filter((r) => (r.line ?? '') === name);
        return branch(`${b.id}/${name}`, name, sumCents(own), merchantLeaves(own));
      })
      .sort(bySize);
    return branch(b.id, b.name, sumCents(inGroup), nodes);
  });

  // Tutto ciò che non sta in un secchio finisce qui: nessun euro deve sparire dal totale.
  const ids = new Set(buckets.map((b) => b.id));
  const unassigned = rows.filter((r) => !r.bucket_id || !ids.has(r.bucket_id));
  const top = groups.filter((g) => g.cents);
  if (unassigned.length) top.push(branch(UNASSIGNED, 'Da assegnare', sumCents(unassigned), merchantLeaves(unassigned)));

  const order = buckets.map((b) => b.id);
  const children = fold(top).map((n) => (order.includes(n.key) ? { ...n, slot: order.indexOf(n.key) < 7 ? order.indexOf(n.key) + 1 : 0 } : n));
  return { key: 'tutte', label: 'Tutte le uscite', cents: sumCents(rows), slot: 0, children };
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
