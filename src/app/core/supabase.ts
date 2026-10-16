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
export type MonthActual = Database['public']['Views']['month_actuals']['Row'];
