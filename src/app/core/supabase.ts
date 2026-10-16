import { createClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

export const supabase = createClient(environment.supabaseUrl, environment.supabaseKey, {
  // L'accesso avviene solo con il codice OTP digitato nell'app, mai da un link.
  auth: { detectSessionInUrl: false },
});
