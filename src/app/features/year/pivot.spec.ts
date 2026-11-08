import { Bucket, MonthLine, MonthOverview } from '../../core/supabase';
import { pivotYear } from './pivot';

const buckets = [
  { id: 'fm', name: 'Future me' },
  { id: 'fun', name: 'Fun' },
] as Bucket[];

const line = (name: string, bucket_id: string | null, forecast: number, actual: number, sort_order = 0): MonthLine => ({
  id: `${name}-${bucket_id}`,
  name,
  bucket_id,
  sort_order,
  over_is_good: name === 'Risparmio',
  forecast,
  actual,
  n: 1,
});

function month(lines: MonthLine[], unassigned: number, start: number | null, end: number | null): MonthOverview {
  return {
    lines,
    unassigned: { actual: unassigned, n: unassigned ? 1 : 0 },
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
    debt_cents: 0,
    debt_pct: null,
  };
}

describe('pivotYear', () => {
  const pivot = pivotYear(
    [
      month([line('Stipendio', null, 2000, 2000), line('Spesa', 'fun', -200, -230, 2), line('Risparmio', 'fm', -300, -250, 1)], -60, null, null),
      // A febbraio la Spesa si è spostata anche in Future me, e "spesa" minuscolo è la stessa riga.
      month([line('spesa', 'fun', -200, -100, 2), line('Spesa', 'fm', 0, -40, 3)], 0, 1000, 1500),
    ],
    buckets,
  );

  it('raggruppa per entrate e per secchio; lo stesso nome compare in più secchi', () => {
    expect(pivot.groups.map((g) => [g.title, g.rows.map((r) => r.label)])).toEqual([
      ['Entrate', ['Stipendio']],
      ['Future me', ['Risparmio', 'Spesa']],
      ['Fun', ['Spesa']],
    ]);
  });

  it('una riga in cui superare il previsto è un bene si colora come il risparmio', () => {
    expect(pivot.groups[1].rows.map((r) => r.kind)).toEqual(['saving', 'expense']);
  });

  it('mette le celle al mese giusto e somma l\'anno', () => {
    const fun = pivot.groups[2].rows[0];
    expect(fun.cells).toEqual([
      { forecast: -200, actual: -230 },
      { forecast: -200, actual: -100 },
    ]);
    expect(fun.total).toEqual({ forecast: -400, actual: -330 });
    expect(pivot.groups[1].rows[1].cells[0]).toEqual({ forecast: null, actual: 0 });
  });

  it('Da assegnare viene dal totale del mese', () => {
    expect(pivot.unassigned.cells.map((c) => c.actual)).toEqual([-60, 0]);
  });

  it('totali: accantonato positivo; i saldi dell\'anno sono il primo e l\'ultimo disponibili', () => {
    const byKey = new Map(pivot.totals.map((t) => [t.key, t]));
    expect(byKey.get('risparmio-tot')!.total).toEqual({ forecast: 600, actual: 500 });
    expect(byKey.get('inizio')!.total.actual).toBe(1000);
    expect(byKey.get('fine')!.total.actual).toBe(1500);
    expect(byKey.get('salvadanaio')!.total.forecast).toBeNull();
  });
});
