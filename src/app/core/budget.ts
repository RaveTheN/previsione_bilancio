import { monthLabel, shiftMonth } from './ledger';
import { centsToInput, parseSignedAmount } from './money';
import { supabase } from './supabase';

type Result = { error: { message: string } | null; status: number };

const ON_CONFLICT = 'user_id,month,category_id,bucket_id';

/** Verso normale di una categoria: entrate positive, uscite e risparmi negativi. */
export function kindSign(kind: string): number {
  return kind === 'income' ? 1 : -1;
}

/**
 * Previsione → testo con il segno, come gli altri importi dell'app. Un importo nel verso
 * opposto alla categoria (es. un rimborso previsto tra le spese) porta il "+" esplicito,
 * così rileggendolo con inputToForecast non cambia verso.
 */
export function signedText(cents: number, kind: string): string {
  return (cents > 0 && kindSign(kind) < 0 ? '+' : '') + centsToInput(cents);
}

/** Testo del campo della previsione (vuoto se non c'è o se è quella predefinita). */
export function forecastToInput(forecast: number | null, kind: string, isDefault: boolean): string {
  return forecast === null || isDefault ? '' : signedText(forecast, kind);
}

/**
 * Testo del campo → previsione; null = nessuna previsione; undefined = non valido.
 * Senza segno vale il verso della categoria (uscite negative); con "-" o "+" vale quello scritto.
 */
export function inputToForecast(text: string, kind: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const explicit = /^[+-]/.test(t);
  const cents = parseSignedAmount(t.replace(/^\+/, ''));
  if (cents === null) return undefined;
  return explicit ? cents : cents * kindSign(kind) || 0;
}

/** Scrive la previsione di una riga; con null la cancella (per il risparmio torna la predefinita). */
export async function writeForecast(month: string, categoryId: string, bucketId: string | null, amount: number | null): Promise<Result> {
  if (amount !== null) {
    const row = { month, category_id: categoryId, bucket_id: bucketId, amount_cents: amount };
    return await supabase.from('budget_lines').upsert(row, { onConflict: ON_CONFLICT });
  }
  const q = supabase.from('budget_lines').delete().eq('month', month).eq('category_id', categoryId);
  return await (bucketId ? q.eq('bucket_id', bucketId) : q.is('bucket_id', null));
}

export interface ForecastLine {
  category_id: string;
  bucket_id: string | null;
  forecast: number;
}

/**
 * Copia le righe nei mesi dopo `from`, fino a `until` compreso: sostituisce le stesse righe
 * (categoria e secchio) e lascia le altre. Se ne sostituisce qualcuna chiede conferma.
 */
export async function copyForecast(from: string, until: string, lines: ForecastLine[]): Promise<Result | 'cancelled'> {
  const months: string[] = [];
  for (let m = shiftMonth(from, 1); m <= until; m = shiftMonth(m, 1)) months.push(m);
  const existing = await supabase.from('budget_lines').select('category_id, bucket_id').gt('month', from).lte('month', until);
  if (existing.error) return existing;
  const keys = new Set(lines.map((l) => `${l.category_id}/${l.bucket_id}`));
  const replaced = existing.data.filter((r) => keys.has(`${r.category_id}/${r.bucket_id}`)).length;
  const range = `${monthLabel(months[0])} – ${monthLabel(until)}`;
  if (replaced && !confirm(`In ${range} ${replaced === 1 ? 'una previsione verrà sostituita' : `${replaced} previsioni verranno sostituite`}. Continuare?`)) {
    return 'cancelled';
  }
  const rows = months.flatMap((month) =>
    lines.map((l) => ({ month, category_id: l.category_id, bucket_id: l.bucket_id, amount_cents: l.forecast })),
  );
  return await supabase.from('budget_lines').upsert(rows, { onConflict: ON_CONFLICT });
}
