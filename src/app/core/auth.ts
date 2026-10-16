import { Injectable, signal } from '@angular/core';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

@Injectable({ providedIn: 'root' })
export class Auth {
  readonly session = signal<Session | null>(null);
  /** Si risolve quando la sessione salvata sul dispositivo è stata letta. */
  readonly ready: Promise<void>;

  constructor() {
    this.ready = supabase.auth.getSession().then(({ data }) => this.session.set(data.session));
    supabase.auth.onAuthStateChange((_event, session) => this.session.set(session));
  }

  /** Invia il codice solo a un utente già esistente: le iscrizioni sono chiuse. */
  async sendCode(email: string): Promise<void> {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) throw error;
  }

  async verifyCode(email: string, token: string): Promise<void> {
    const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  }
}
