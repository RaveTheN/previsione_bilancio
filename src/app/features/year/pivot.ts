import { Bucket, Category, MonthOverview } from '../../core/supabase';

export interface Cell {
  /** null = nessuna previsione. */
  forecast: number | null;
  /** null solo nei residui prima del mese di avvio. */
  actual: number | null;
  isDefault: boolean;
}

export interface GridRow {
  key: string;
  label: string;
  kind: string;
  categoryId: string | null;
  bucketId: string | null;
  /** Riga categoria/secchio: la previsione si modifica. */
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

const empty = (): Cell => ({ forecast: null, actual: 0, isDefault: false });

function add(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : a + b;
}

function sum(cells: Cell[]): Cell {
  return cells.reduce((s, c) => ({ forecast: add(s.forecast, c.forecast), actual: add(s.actual, c.actual), isDefault: false }), {
    forecast: null,
    actual: 0,
    isDefault: false,
  });
}

/**
 * Dai 12 month_overview dell'anno alle righe della griglia. Nessun calcolo nuovo: le celle
 * sono quelle della vista mese, qui si raggruppano soltanto (stesse regole di Month).
 */
export function pivotYear(months: MonthOverview[], categories: Map<string, Category>, buckets: Bucket[]): YearPivot {
  const rows = new Map<string, GridRow>();
  const unassigned: GridRow = {
    key: 'da-assegnare',
    label: 'Da assegnare',
    kind: 'expense',
    categoryId: null,
    bucketId: null,
    editable: false,
    cells: months.map(empty),
    total: empty(),
  };

  months.forEach((month, i) => {
    for (const line of month.lines) {
      const cat = line.category_id ? categories.get(line.category_id) : undefined;
      const kind = cat?.kind ?? (line.inflow ? 'income' : 'expense');
      if (!cat || (kind !== 'income' && !line.bucket_id)) {
        unassigned.cells[i].actual = (unassigned.cells[i].actual ?? 0) + line.actual;
        continue;
      }
      const key = `${line.category_id}/${line.bucket_id}`;
      let row = rows.get(key);
      if (!row) {
        row = { key, label: cat.name, kind, categoryId: cat.id, bucketId: line.bucket_id, editable: true, cells: months.map(empty), total: empty() };
        rows.set(key, row);
      }
      row.cells[i] = { forecast: line.forecast, actual: line.actual, isDefault: line.is_default };
    }
  });

  const order = (r: GridRow) => categories.get(r.categoryId ?? '')?.sort_order ?? 0;
  const all = [...rows.values()].sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label));
  for (const row of [...all, unassigned]) row.total = sum(row.cells);

  const group = (key: string, title: string, keep: (r: GridRow) => boolean): GridGroup => {
    const members = all.filter(keep);
    const cells = months.map((_, i) => sum(members.map((r) => r.cells[i])));
    return { key, title, rows: members, cells, total: sum(cells) };
  };
  const groups = [
    group('entrate', 'Entrate', (r) => r.kind === 'income'),
    ...buckets.map((b) => group(b.id, b.name, (r) => r.kind !== 'income' && r.bucketId === b.id)),
  ].filter((g) => g.rows.length);

  // Totali come nella vista mese. Per i saldi il valore dell'anno è il primo (residuo
  // iniziale) o l'ultimo (fine mese, Salvadanaio) disponibile, non la somma.
  const flow = (key: string, label: string, kind: string, f: (m: MonthOverview) => number, a: (m: MonthOverview) => number): GridRow => {
    const cells = months.map((m) => ({ forecast: f(m), actual: a(m), isDefault: false }));
    return { key, label, kind, categoryId: null, bucketId: null, editable: false, cells, total: sum(cells) };
  };
  const balance = (key: string, label: string, f: (m: MonthOverview) => number | null, a: (m: MonthOverview) => number | null, first: boolean): GridRow => {
    const cells = months.map((m) => ({ forecast: f(m), actual: a(m), isDefault: false }));
    const pick = (values: (number | null)[]) => (first ? values : [...values].reverse()).find((v) => v !== null) ?? null;
    const total = { forecast: pick(cells.map((c) => c.forecast)), actual: pick(cells.map((c) => c.actual)), isDefault: false };
    return { key, label, kind: 'balance', categoryId: null, bucketId: null, editable: false, cells, total };
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
