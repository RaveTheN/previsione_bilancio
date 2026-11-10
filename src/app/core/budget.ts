import { monthLabel, shiftMonth } from './ledger';
import { centsToInput, parseSignedAmount } from './money';
import { MonthLine, supabase } from './supabase';

type Result = { error: { message: string } | null; status: number };

/**
 * Righe che muovono il Salvadanaio, riconosciute per nome (come "Risparmio") anche dal database:
 * rinominate, tornano righe normali. Il prelievo sta tra le Entrate, l'arrotondamento in un secchio.
 */
export const RESERVE_LINES = {
  withdrawal: { name: 'Prelievo dal Salvadanaio', note: 'Tra le Entrate: aggiunge soldi spendibili e li toglie dal Salvadanaio.' },
  roundup: { name: 'Arrotonda acquisti', note: 'Toglie dal conto principale e mette nel Salvadanaio, come il Risparmio.' },
} as const;
export type ReserveLineType = keyof typeof RESERVE_LINES;

/** Verso di una riga: le entrate (senza secchio) positive, le righe dei secchi negative. Con 'saving' superare il previsto è un bene. */
export function lineKind(bucketId: string | null, overIsGood = false): 'income' | 'expense' | 'saving' {
  return !bucketId ? 'income' : overIsGood ? 'saving' : 'expense';
}

export function kindSign(kind: string): number {
  return kind === 'income' ? 1 : -1;
}

/** Quanto resta di un secchio nel mese: previsto meno speso, con importi negativi; sotto zero se hai sforato. */
export function bucketLeft(lines: MonthLine[], bucketId: string): number {
  return lines.filter((l) => l.bucket_id === bucketId).reduce((sum, l) => sum + l.actual - l.forecast, 0);
}

/** Le righe del mese con una riga già nel nuovo secchio: serve a mostrarla subito mentre si salva. */
export function moveLine(lines: MonthLine[], id: string, to: string): MonthLine[] {
  return lines.map((l) => (l.id === id ? { ...l, bucket_id: to } : l));
}

/**
 * Previsione → testo con il segno, come gli altri importi dell'app. Un importo nel verso
 * opposto alla riga (es. un rimborso previsto tra le spese) porta il "+" esplicito,
 * così rileggendolo con inputToForecast non cambia verso.
 */
export function signedText(cents: number, kind: string): string {
  return (cents > 0 && kindSign(kind) < 0 ? '+' : '') + centsToInput(cents);
}

/**
 * Testo del campo → previsione; null = campo vuoto; undefined = non valido.
 * Senza segno vale il verso della riga (uscite negative); con "-" o "+" vale quello scritto.
 */
export function inputToForecast(text: string, kind: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const explicit = /^[+-]/.test(t);
  const cents = parseSignedAmount(t.replace(/^\+/, ''));
  if (cents === null) return undefined;
  return explicit ? cents : cents * kindSign(kind) || 0;
}

export async function addLine(month: string, name: string, bucketId: string | null, amount: number, sortOrder: number, overIsGood: boolean): Promise<Result> {
  return await supabase.from('budget_lines').insert({ month, name: name.trim(), bucket_id: bucketId, amount_cents: amount, sort_order: sortOrder, over_is_good: overIsGood });
}

/** Rinomina, sposta di secchio o cambia il previsto di una riga: i suoi movimenti la seguono. */
export async function updateLine(id: string, patch: { name?: string; bucket_id?: string; amount_cents?: number }): Promise<Result> {
  return await supabase.from('budget_lines').update(patch).eq('id', id);
}

/** Elimina la riga: i suoi movimenti tornano da assegnare. */
export async function deleteLine(id: string): Promise<Result> {
  return await supabase.from('budget_lines').delete().eq('id', id);
}

/**
 * Scrive il previsto della riga con quel nome nel mese (dalla griglia annuale): la crea se manca;
 * con null la azzera senza crearla. Un mese vuoto prima copia le righe del mese precedente.
 */
export async function writeByName(month: string, name: string, bucketId: string | null, amount: number | null, overIsGood: boolean): Promise<Result> {
  const ensured = await supabase.rpc('ensure_month_lines', { p_month: month });
  if (ensured.error) return ensured;
  if (amount === null) return await supabase.from('budget_lines').update({ amount_cents: 0 }).eq('month', month).eq('name', name);
  const row = { month, name, bucket_id: bucketId, amount_cents: amount, over_is_good: overIsGood };
  return await supabase.from('budget_lines').upsert(row, { onConflict: 'user_id,month,name' });
}

export interface ForecastLine {
  name: string;
  bucket_id: string | null;
  forecast: number;
  sort_order: number;
  over_is_good: boolean;
}

/**
 * Copia le righe nei mesi dopo `from`, fino a `until` compreso: sostituisce le righe con lo
 * stesso nome e lascia le altre. Se ne sostituisce qualcuna chiede conferma.
 */
export async function copyForecast(from: string, until: string, lines: ForecastLine[]): Promise<Result | 'cancelled'> {
  const months: string[] = [];
  for (let m = shiftMonth(from, 1); m <= until; m = shiftMonth(m, 1)) months.push(m);
  const existing = await supabase.from('budget_lines').select('name').gt('month', from).lte('month', until);
  if (existing.error) return existing;
  const names = new Set(lines.map((l) => l.name));
  const replaced = existing.data.filter((r) => names.has(r.name)).length;
  const range = `${monthLabel(months[0])} – ${monthLabel(until)}`;
  if (replaced && !confirm(`In ${range} ${replaced === 1 ? 'una riga verrà sostituita' : `${replaced} righe verranno sostituite`}. Continuare?`)) {
    return 'cancelled';
  }
  // I mesi vuoti prima prendono tutte le righe del mese precedente, come quando si aprono.
  for (const month of months) {
    const ensured = await supabase.rpc('ensure_month_lines', { p_month: month });
    if (ensured.error) return ensured;
  }
  const rows = months.flatMap((month) =>
    lines.map((l) => ({ month, name: l.name, bucket_id: l.bucket_id, amount_cents: l.forecast, sort_order: l.sort_order, over_is_good: l.over_is_good })),
  );
  return await supabase.from('budget_lines').upsert(rows, { onConflict: 'user_id,month,name' });
}
