import { createClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import type { Database } from './database.types';

export const supabase = createClient<Database>(environment.supabaseUrl, environment.supabaseKey, {
  // L'accesso avviene solo con il codice OTP digitato nell'app, mai da un link.
  auth: { detectSessionInUrl: false },
});

type Tables = Database['public']['Tables'];
export type Bucket = Tables['buckets']['Row'];
export type Account = Tables['accounts']['Row'];
export type Tag = Tables['tags']['Row'];
export type Transaction = Tables['transactions']['Row'] & { transaction_tags?: { tag_id: string }[] };
export type Settings = Tables['settings']['Row'];
export type ApiToken = Tables['api_tokens']['Row'];
export type Card = Tables['cards']['Row'];
export type IngestEvent = Tables['ingest_events']['Row'];
export type Merchant = Tables['merchants']['Row'];
export type MerchantAlias = Tables['merchant_aliases']['Row'];
export type ParseRule = Tables['parse_rules']['Row'];
export type BudgetLine = Tables['budget_lines']['Row'];
export type WishlistItem = Tables['wishlist_items']['Row'];
export type Person = Tables['people']['Row'];
export type SharedEntry = Tables['shared_entries']['Row'];
export type DebtPlan = Database['public']['Functions']['debt_plan']['Returns'][number];
export type InboxName = Database['public']['Views']['merchant_inbox']['Row'];

/** Riga di month_overview: una riga del mese (secchio vuoto = entrata), con previsto ed effettivo. */
export interface MonthLine {
  id: string;
  name: string;
  bucket_id: string | null;
  sort_order: number;
  forecast: number;
  /** Somma con segno dei movimenti assegnati: i rimborsi compensano le spese. */
  actual: number;
  n: number;
}

/** Risultato (jsonb) di month_overview: la forma è definita nella migrazione "righe_libere". */
export interface MonthOverview {
  lines: MonthLine[];
  /** Movimenti del mese senza riga. */
  unassigned: { actual: number; n: number };
  income_forecast: number;
  income_actual: number;
  expense_forecast: number;
  expense_actual: number;
  saving_forecast: number;
  saving_actual: number;
  /** I residui sono null prima del mese di avvio o senza impostazioni. */
  start_forecast: number | null;
  start_actual: number | null;
  end_forecast: number | null;
  end_actual: number | null;
  /** null se non ci sono conti riserva. */
  reserve_forecast: number | null;
  reserve_actual: number | null;
  /** Percentuali sulle entrate; null quando le entrate mancano. */
  buckets: { bucket_id: string; target_pct: number; forecast_pct: number | null; actual_pct: number | null }[];
  /** Le rate che cadono nel mese e il loro peso sulle entrate; null quando le entrate mancano. */
  debt_cents: number;
  debt_pct: number | null;
}

/** Bonifici e addebiti PayPal non sono esercenti: si assegnano uno per uno (stessa regola di merchant_key nel database). */
export function isGenericOperation(merchantRaw: string | null): boolean {
  return !!merchantRaw && /^\s*(bonifico|addebito paypal)\b/i.test(merchantRaw);
}

/** Testo dell'errore di una chiamata: status 0 vuol dire che la richiesta non è partita. */
export function errorText(res: { error: { message: string } | null; status: number }): string {
  return res.status === 0 ? 'nessuna connessione' : (res.error?.message ?? '');
}
