import { lineKind } from '../../core/budget';
import { Bucket, MonthOverview } from '../../core/supabase';

export interface Cell {
  /** null = la riga non c'è in quel mese. */
  forecast: number | null;
  /** null solo nei residui prima del mese di avvio. */
  actual: number | null;
}

export interface GridRow {
  key: string;
  label: string;
  kind: string;
  bucketId: string | null;
  /** Riga del mese (nome e secchio): la previsione si modifica. */
  editable: boolean;
  cells: Cell[];
  total: Cell;
}

export interface GridGroup {
  key: string;
  title: string;
  rows: GridRow[];
  /** Somma delle righe, mese per mese e sull'anno. */
  cells: Cell[];
  total: Cell;
}

export interface YearPivot {
  groups: GridGroup[];
  unassigned: GridRow;
  totals: GridRow[];
}

const empty = (): Cell => ({ forecast: null, actual: 0 });

function add(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : a + b;
}

function sum(cells: Cell[]): Cell {
  return cells.reduce((s, c) => ({ forecast: add(s.forecast, c.forecast), actual: add(s.actual, c.actual) }), { forecast: null, actual: 0 });
}

/**
 * Dai 12 month_overview dell'anno alle righe della griglia. Nessun calcolo nuovo: le celle
 * sono quelle della vista mese, qui si raggruppano soltanto. Una riga dell'anno è un nome in
 * un secchio: lo stesso nome nei vari mesi è la stessa riga, come nel foglio.
 */
export function pivotYear(months: MonthOverview[], buckets: Bucket[]): YearPivot {
  const rows = new Map<string, GridRow & { order: number }>();
  const unassigned: GridRow = {
    key: 'da-assegnare',
    label: 'Da assegnare',
    kind: 'expense',
    bucketId: null,
    editable: false,
    cells: months.map((m) => ({ forecast: null, actual: m.unassigned.actual })),
    total: empty(),
  };

  months.forEach((month, i) => {
    for (const line of month.lines) {
      const key = `${line.bucket_id}/${line.name.toLowerCase()}`;
      let row = rows.get(key);
      if (!row) {
        row = { key, label: line.name, kind: lineKind(line.bucket_id), bucketId: line.bucket_id, editable: true, cells: months.map(empty), total: empty(), order: line.sort_order };
        rows.set(key, row);
      }
      row.cells[i] = { forecast: line.forecast, actual: line.actual };
    }
  });

  const all = [...rows.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  for (const row of [...all, unassigned]) row.total = sum(row.cells);

  const group = (key: string, title: string, bucketId: string | null): GridGroup => {
    const members = all.filter((r) => r.bucketId === bucketId);
    const cells = months.map((_, i) => sum(members.map((r) => r.cells[i])));
    return { key, title, rows: members, cells, total: sum(cells) };
  };
  const groups = [group('entrate', 'Entrate', null), ...buckets.map((b) => group(b.id, b.name, b.id))].filter((g) => g.rows.length);

  // Totali come nella vista mese. Per i saldi il valore dell'anno è il primo (residuo
  // iniziale) o l'ultimo (fine mese, Salvadanaio) disponibile, non la somma.
  const flow = (key: string, label: string, kind: string, f: (m: MonthOverview) => number, a: (m: MonthOverview) => number): GridRow => {
    const cells = months.map((m) => ({ forecast: f(m), actual: a(m) }));
    return { key, label, kind, bucketId: null, editable: false, cells, total: sum(cells) };
  };
  const balance = (key: string, label: string, f: (m: MonthOverview) => number | null, a: (m: MonthOverview) => number | null, first: boolean): GridRow => {
    const cells = months.map((m) => ({ forecast: f(m), actual: a(m) }));
    const pick = (values: (number | null)[]) => (first ? values : [...values].reverse()).find((v) => v !== null) ?? null;
    const total = { forecast: pick(cells.map((c) => c.forecast)), actual: pick(cells.map((c) => c.actual)) };
    return { key, label, kind: 'balance', bucketId: null, editable: false, cells, total };
  };
  const totals = [
    balance('inizio', 'Residuo iniziale', (m) => m.start_forecast, (m) => m.start_actual, true),
    flow('entrate-tot', 'Entrate', 'income', (m) => m.income_forecast, (m) => m.income_actual),
    flow('uscite-tot', 'Uscite', 'expense', (m) => m.expense_forecast, (m) => m.expense_actual),
    // Positivo come nella vista mese: accantonare di più è meglio, come un'entrata.
    flow('risparmio-tot', 'Accantonato', 'income', (m) => -m.saving_forecast, (m) => -m.saving_actual),
    balance('fine', 'Disponibile a fine mese', (m) => m.end_forecast, (m) => m.end_actual, false),
    balance('salvadanaio', 'Salvadanaio', (m) => m.reserve_forecast, (m) => m.reserve_actual, false),
  ];

  return { groups, unassigned, totals };
}
