import { lastDay, monthLabel, shiftMonth } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { lineKind } from '../../core/budget';
import { Bucket, MonthLine, MonthOverview } from '../../core/supabase';

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
  /** In un grafico a colonne: una linea sopra le colonne, con il suo asse a destra. */
  line?: boolean;
}

export interface ChartSpec {
  /** Colonne impilate, colonne affiancate, linee o barre orizzontali raggruppate. */
  form: 'columns' | 'vbars' | 'line' | 'bars';
  /** Le serie (previsto ed effettivo) si possono guardare anche una per volta. */
  toggle?: true;
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

const MAX_MONTHS = 36;

/** Un intervallo di mesi scritto a mano: mai prima dell'avvio, nell'ordine giusto, al massimo tre anni. */
export function clampRange(from: string, to: string, goLive: string | null): { from: string; to: string } {
  const start = goLive && goLive > from ? goLive : from;
  const max = shiftMonth(start, MAX_MONTHS - 1);
  return { from: start, to: to < start ? start : to > max ? max : to };
}

/**
 * Mesi inclusi di una scorciatoia: "m6" = ultimi mesi, "p1" = mese scorso, "f12" = i prossimi
 * a partire da quello in corso, "y2026" = anno.
 */
export function periodRange(period: string, current: string, goLive: string | null): { from: string; to: string } {
  const n = Number(period.slice(1));
  const ranges: Record<string, [string, string]> = {
    y: [`${n}-01-01`, `${n}-12-01`],
    f: [current, shiftMonth(current, n - 1)],
    p: [shiftMonth(current, -n), shiftMonth(current, -n)],
    m: [shiftMonth(current, 1 - n), current],
  };
  const [from, to] = ranges[period[0]];
  return clampRange(from, to, goLive);
}

export function periodOptions(current: string, goLive: string | null): { value: string; label: string }[] {
  const thisYear = Number(current.slice(0, 4));
  const years = [];
  for (let y = Math.min(Number((goLive ?? current).slice(0, 4)), thisYear); y <= thisYear + 1; y++) years.push(y);
  return [
    ...years.map((y) => ({ value: `y${y}`, label: `Anno ${y}` })),
    { value: 'm1', label: 'Questo mese' },
    { value: 'p1', label: 'Mese scorso' },
    { value: 'm3', label: 'Ultimi 3 mesi' },
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
  // Come il disponibile nel database: uscite e accantonamenti sono già negativi, e l'effettivo conta anche i movimenti da assegnare.
  const margin = (m: ChartMonth, k: 'forecast' | 'actual') => m[`income_${k}`] + m[`expense_${k}`] + m[`saving_${k}`] + (k === 'actual' ? m.unassigned.actual : 0);
  const planned = months.filter((m) => m.month >= current);
  const worst = planned.length ? planned.reduce((a, b) => (margin(b, 'forecast') < margin(a, 'forecast') ? b : a)) : null;
  const sum = planned.reduce((s, m) => s + margin(m, 'forecast'), 0);
  return {
    form: 'columns',
    toggle: true,
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
    toggle: true,
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

/**
 * La torta senza le fette tolte a mano: le chiavi portano il percorso ("secchio>riga>esercente"),
 * e i totali dei livelli sopra scendono di conseguenza.
 */
export function prune(node: PieNode, hidden: ReadonlySet<string>, path = ''): PieNode {
  let cents = node.cents;
  const children: PieNode[] = [];
  for (const child of node.children) {
    const key = path + child.key;
    const kept = hidden.has(key) ? null : prune(child, hidden, key + '>');
    cents -= child.cents - (kept?.cents ?? 0);
    if (kept) children.push(kept);
  }
  return { ...node, cents, children };
}

/**
 * I mesi senza le righe escluse (per nome). Le percentuali dei secchi si ricalcolano sulle righe
 * rimaste, con la stessa base del database: tutte le entrate, effettive o, se mancano, previste.
 */
export function withoutLines(months: ChartMonth[], excluded: ReadonlySet<string>): ChartMonth[] {
  if (!excluded.size) return months;
  return months.map((m) => {
    const lines = m.lines.filter((l) => !excluded.has(l.name));
    const base = m.income_actual || m.income_forecast;
    const spent = (id: string) => lines.filter((l) => l.bucket_id === id).reduce((s, l) => s + l.actual, 0);
    // || 0: senza spese il meno darebbe "-0".
    return { ...m, lines, buckets: m.buckets.map((b) => ({ ...b, actual_pct: base > 0 ? Math.round((-1000 * spent(b.bucket_id)) / base) / 10 || 0 : null })) };
  });
}

/** I nomi delle righe del periodo, per il filtro di un grafico: entrate, o righe dei secchi. */
export function lineNames(months: ChartMonth[], kind: 'income' | 'expense'): string[] {
  const names = months.flatMap((m) => m.lines.filter((l) => (kind === 'income') === !l.bucket_id).map((l) => l.name));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'it'));
}

/** Un movimento letto per i grafici giornalieri, con la sua riga. */
export interface RawMovement {
  booking_date: string;
  amount_cents: number;
  line_id: string | null;
  transfer_group_id: string | null;
  budget_lines: { name: string; bucket_id: string | null } | null;
}

/** Un'uscita con il suo giorno, in positivo: un rimborso sulla stessa riga è negativo. */
export interface DaySpend {
  date: string;
  cents: number;
  line: string | null;
  bucket_id: string | null;
}

/** Stessa regola della torta (chart_data nel database): le righe dei secchi e le uscite da assegnare. */
export function daySpending(rows: RawMovement[]): DaySpend[] {
  return rows
    .filter((t) => (t.budget_lines ? !!t.budget_lines.bucket_id : !t.line_id && !t.transfer_group_id && t.amount_cents < 0))
    .map((t) => ({ date: t.booking_date, cents: -t.amount_cents, line: t.budget_lines?.name ?? null, bucket_id: t.budget_lines?.bucket_id ?? null }));
}

/** Fino a che giorno si confronta: oggi se il mese è quello in corso, altrimenti tutto il mese. */
export function compareDay(month: string, today: string): number {
  return today.startsWith(month.slice(0, 7)) ? Number(today.slice(8)) : 31;
}

/** Le uscite di due mesi fino allo stesso giorno: una coppia di colonne per secchio, più il totale. */
export function compareChart(rows: DaySpend[], month: string, other: string, day: number, buckets: Bucket[]): ChartSpec {
  const upTo = (m: string, match: (r: DaySpend) => boolean = () => true) =>
    sumCents(rows.filter((r) => r.date.startsWith(m.slice(0, 7)) && Number(r.date.slice(8)) <= day && match(r)));
  const [a, b] = [upTo(month), upTo(other)];
  if (!a && !b) return empty('Nessuna uscita nei due mesi.');
  const ids = new Set(buckets.map((bk) => bk.id));
  const groups = [
    ...buckets.map((bk) => ({ label: bk.name, match: (r: DaySpend) => r.bucket_id === bk.id })),
    { label: 'Da assegnare', match: (r: DaySpend) => !r.bucket_id || !ids.has(r.bucket_id) },
  ].filter((g) => upTo(month, g.match) || upTo(other, g.match));
  const values = (m: string) => [...groups.map((g) => upTo(m, g.match)), upTo(m)];
  const name = (m: string) => monthLabel(m).toLowerCase();
  return {
    form: 'vbars',
    unit: 'cents',
    labels: [...groups.map((g) => g.label), 'Totale'],
    series: [
      { label: monthLabel(month), slot: 1, values: values(month) },
      { label: monthLabel(other), slot: 0, values: values(other) },
    ].slice(0, month === other ? 1 : 2),
    summary:
      `${day >= 31 ? 'Mese intero' : `Fino al giorno ${day}`}: ${name(month)} ${formatCents(a)}, ${name(other)} ${formatCents(b)}` +
      (a === b ? '.' : `: ${formatCents(Math.abs(a - b))} in ${a > b ? 'più' : 'meno'}.`),
  };
}

/** Le uscite giorno per giorno, con la cumulata del mese: i giorni non ancora arrivati restano vuoti. */
export function dailyChart(rows: DaySpend[], month: string, today: string): ChartSpec {
  const days = Number(lastDay(month).slice(8));
  const perDay = Array.from({ length: days }, (_, i) => sumCents(rows.filter((r) => r.date === month.slice(0, 8) + String(i + 1).padStart(2, '0'))));
  if (!perDay.some(Boolean)) return empty('Nessuna uscita nel mese.');
  const reached = Math.min(compareDay(month, today), month > today ? 0 : days);
  const total = sumCents(perDay.map((cents) => ({ cents })));
  const top = perDay.indexOf(Math.max(...perDay));
  let sum = 0;
  return {
    form: 'vbars',
    unit: 'cents',
    labels: perDay.map((_, i) => String(i + 1)),
    series: [
      { label: 'Spesa del giorno', slot: 1, values: perDay.map((cents, i) => (i < reached || cents ? cents : null)) },
      { label: 'Cumulata del mese', slot: 0, dashed: true, line: true, values: perDay.map((cents, i) => ((sum += cents), i < reached ? sum : null)) },
    ],
    summary:
      `${monthLabel(month)}: ${formatCents(total)}, in media ${formatCents(Math.round(total / Math.max(reached, 1)))} al giorno. ` +
      `Il giorno più caro: il ${top + 1}, con ${formatCents(perDay[top])}.`,
  };
}

/** Riepilogo di un mese in elenco: l'effettivo fino al mese in corso, il previsto per i futuri. */
export function monthRow(m: ChartMonth, current: string): { month: string; income: number; expense: number; end: number | null; reserve: number | null } {
  const k = m.month > current ? 'forecast' : 'actual';
  // Il Salvadanaio è quello che segue le righe, come nel riquadro della vista mese.
  return { month: m.month, income: m[`income_${k}`], expense: m[`expense_${k}`], end: m[`end_${k}`], reserve: m.reserve_forecast };
}

/** Le righe con lo scostamento maggiore tra previsto ed effettivo. */
export function topGaps(m: ChartMonth, limit = 3): MonthLine[] {
  const gap = (l: MonthLine) => Math.abs(l.actual - l.forecast);
  return m.lines.filter(gap).sort((a, b) => gap(b) - gap(a)).slice(0, limit);
}

/** I primi esercenti per spesa, dalle uscite per riga: così seguono il filtro delle righe. */
export function topMerchants(rows: ChartData['spending'], limit = 10): ChartData['merchants'] {
  const sums = new Map<string, number>();
  for (const r of rows) if (r.merchant) sums.set(r.merchant, (sums.get(r.merchant) ?? 0) + r.cents);
  return [...sums]
    .map(([name, cents]) => ({ name, cents }))
    .filter((m) => m.cents > 0)
    .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
    .slice(0, limit);
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
