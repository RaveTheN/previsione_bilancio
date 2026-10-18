import { createClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import type { Database } from './database.types';

export const supabase = createClient<Database>(environment.supabaseUrl, environment.supabaseKey, {
  // L'accesso avviene solo con il codice OTP digitato nell'app, mai da un link.
  auth: { detectSessionInUrl: false },
});

type Tables = Database['public']['Tables'];
export type Category = Tables['categories']['Row'];
export type Bucket = Tables['buckets']['Row'];
export type Account = Tables['accounts']['Row'];
export type Tag = Tables['tags']['Row'];
export type Transaction = Tables['transactions']['Row'] & { transaction_tags?: { tag_id: string }[] };
export type Settings = Tables['settings']['Row'];
export type ApiToken = Tables['api_tokens']['Row'];
export type Card = Tables['cards']['Row'];
export type IngestEvent = Tables['ingest_events']['Row'];

/** Riga di month_overview: categoria e secchio, con previsione ed effettivo del mese. */
export interface MonthLine {
  category_id: string | null;
  bucket_id: string | null;
  /** Solo senza categoria: separa le entrate dalle uscite da assegnare. */
  inflow: boolean | null;
  /** null = nessuna previsione per la riga. */
  forecast: number | null;
  actual: number;
  n: number;
  /** Risparmio predefinito (percentuale dello stipendio), non scritto dall'utente. */
  is_default: boolean;
}

/** Risultato (jsonb) di month_overview: la forma è definita nella migrazione "previsioni". */
export interface MonthOverview {
  lines: MonthLine[];
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
  /** Percentuali sullo stipendio; null quando lo stipendio manca. */
  buckets: { bucket_id: string; target_pct: number; forecast_pct: number | null; actual_pct: number | null }[];
}

/** Testo dell'errore di una chiamata: status 0 vuol dire che la richiesta non è partita. */
export function errorText(res: { error: { message: string } | null; status: number }): string {
  return res.status === 0 ? 'nessuna connessione' : (res.error?.message ?? '');
}
