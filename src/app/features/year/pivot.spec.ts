import { Bucket, Category, MonthLine, MonthOverview } from '../../core/supabase';
import { pivotYear } from './pivot';

const cat = (id: string, name: string, kind: string, sort_order: number) => ({ id, name, kind, sort_order }) as Category;
const categories = new Map(
  [cat('stip', 'Stipendio', 'income', 1), cat('ris', 'Risparmio', 'saving', 2), cat('spesa', 'Spesa', 'expense', 3)].map((c) => [c.id, c]),
);
const buckets = [
  { id: 'fm', name: 'Future me' },
  { id: 'fun', name: 'Fun' },
] as Bucket[];

const line = (category_id: string | null, bucket_id: string | null, forecast: number | null, actual: number, extra: Partial<MonthLine> = {}): MonthLine => ({
  category_id,
  bucket_id,
  inflow: null,
  forecast,
  actual,
  n: 1,
  is_default: false,
  ...extra,
});

function month(lines: MonthLine[], start: number | null, end: number | null): MonthOverview {
  return {
    lines,
    income_forecast: 0,
    income_actual: 0,
    expense_forecast: 0,
    expense_actual: 0,
    saving_forecast: -300,
    saving_actual: -250,
    start_forecast: start,
    start_actual: start,
    end_forecast: end,
    end_actual: end,
    reserve_forecast: null,
    reserve_actual: null,
    buckets: [],
  };
}

describe('pivotYear', () => {
  const pivot = pivotYear(
    [
      month(
        [
          line('stip', null, 2000, 2000),
          line('spesa', 'fun', -200, -230),
          line('ris', 'fm', -300, -250, { is_default: true }),
          line(null, null, null, -50, { inflow: false }),
          line('spesa', null, null, -10),
        ],
        null,
        null,
      ),
      month([line('spesa', 'fun', -200, -100), line('spesa', 'fm', null, -40)], 1000, 1500),
    ],
    categories,
    buckets,
  );

  it('raggruppa per entrate e per secchio; la stessa categoria compare in più secchi', () => {
    expect(pivot.groups.map((g) => [g.title, g.rows.map((r) => r.label)])).toEqual([
      ['Entrate', ['Stipendio']],
      ['Future me', ['Risparmio', 'Spesa']],
      ['Fun', ['Spesa']],
    ]);
  });

  it('mette le celle al mese giusto e somma l\'anno', () => {
    const fun = pivot.groups[2].rows[0];
    expect(fun.cells.map((c) => [c.forecast, c.actual])).toEqual([
      [-200, -230],
      [-200, -100],
    ]);
    expect(fun.total).toEqual({ forecast: -400, actual: -330, isDefault: false });
    expect(pivot.groups[1].rows[0].cells[0].isDefault).toBe(true);
    expect(pivot.groups[1].cells[1]).toEqual({ forecast: null, actual: -40, isDefault: false });
  });

  it('senza categoria, o uscita senza secchio: in Da assegnare', () => {
    expect(pivot.unassigned.cells.map((c) => c.actual)).toEqual([-60, 0]);
  });

  it('totali: accantonato positivo; i saldi dell\'anno sono il primo e l\'ultimo disponibili', () => {
    const byKey = new Map(pivot.totals.map((t) => [t.key, t]));
    expect(byKey.get('risparmio-tot')!.total).toEqual({ forecast: 600, actual: 500, isDefault: false });
    expect(byKey.get('inizio')!.total.actual).toBe(1000);
    expect(byKey.get('fine')!.total.actual).toBe(1500);
    expect(byKey.get('salvadanaio')!.total.forecast).toBeNull();
  });
});
