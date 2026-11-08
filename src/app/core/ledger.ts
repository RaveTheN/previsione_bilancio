import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Auth } from './auth';
import { applyPending } from './queue';
import { Account, Bucket, Merchant, MonthOverview, Settings, supabase, Tag, Transaction } from './supabase';
import { Sync } from './sync';

/** Data di oggi in ora italiana, "2026-10-16". */
export function todayIso(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

/** "2026-10-01" del mese corrente. */
export function currentMonth(): string {
  return todayIso().slice(0, 7) + '-01';
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}

/** Ultimo giorno del mese che inizia in `month`. */
export function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Data proposta per un movimento nuovo: oggi, oppure l'ultimo giorno se stai guardando un mese passato. */
export function defaultDate(month: string, today = todayIso()): string {
  return lastDay(month) < today ? lastDay(month) : today;
}

export function monthLabel(month: string): string {
  const label = new Date(month + 'T12:00:00').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Dati del mese selezionato e dati di riferimento (secchi, conti, tag). */
@Injectable({ providedIn: 'root' })
export class Ledger {
  private readonly auth = inject(Auth);
  private readonly sync = inject(Sync);

  readonly month = signal(currentMonth());
  readonly buckets = signal<Bucket[]>([]);
  readonly accounts = signal<Account[]>([]);
  readonly tags = signal<Tag[]>([]);
  readonly merchants = signal<Merchant[]>([]);
  readonly settings = signal<Settings | null>(null);
  /** Elementi di "Da rivedere": notifiche non riconosciute e movimenti da controllare. */
  readonly reviewCount = signal(0);
  readonly loadError = signal('');
  private readonly serverRows = signal<Transaction[]>([]);
  private readonly loaded = signal<{ month: string; overview: MonthOverview } | null>(null);

  /** Vista del mese selezionato; null finché non arriva quella giusta, così non si modifica il mese sbagliato. */
  readonly overview = computed(() => {
    const loaded = this.loaded();
    return loaded?.month === this.month() ? loaded.overview : null;
  });

  /** Movimenti del mese, compresi quelli ancora in coda. */
  readonly transactions = computed(() =>
    applyPending(this.serverRows(), this.sync.ops())
      .filter((t) => t.booking_date?.startsWith(this.month().slice(0, 7)))
      .sort((a, b) => b.booking_date.localeCompare(a.booking_date) || b.occurred_at.localeCompare(a.occurred_at)),
  );

  /** Le righe del mese selezionato, nell'ordine scritto. */
  readonly lines = computed(() => this.overview()?.lines ?? []);
  readonly lineById = computed(() => new Map(this.lines().map((l) => [l.id, l])));
  readonly bucketById = computed(() => new Map(this.buckets().map((b) => [b.id, b])));
  readonly accountById = computed(() => new Map(this.accounts().map((a) => [a.id, a])));
  readonly tagById = computed(() => new Map(this.tags().map((t) => [t.id, t])));
  readonly merchantById = computed(() => new Map(this.merchants().map((m) => [m.id, m])));

  constructor() {
    effect(() => {
      const month = this.month();
      this.sync.synced();
      if (this.auth.session()) untracked(() => void this.load(month));
    });
  }

  async load(month = this.month()): Promise<void> {
    const [buckets, accounts, tags, settings, rows, overview, events, toCheck, merchants] = await Promise.all([
      supabase.from('buckets').select().order('sort_order'),
      supabase.from('accounts').select().order('sort_order'),
      supabase.from('tags').select().order('name'),
      supabase.from('settings').select().maybeSingle(),
      supabase.from('transactions').select('*, transaction_tags(tag_id)').eq('month', month),
      // In GET: il service worker la conserva per la lettura offline.
      supabase.rpc('month_overview', { p_month: month }, { get: true }),
      // Elenchi di soli id (e non conteggi in HEAD): così il badge resta leggibile anche offline.
      supabase.from('ingest_events').select('id').in('status', ['unrecognized', 'error']).is('transaction_id', null),
      supabase.from('transactions').select('id').or('review_reason.not.is.null,status.eq.pending'),
      supabase.from('merchants').select().order('name'),
    ]);
    const error = [buckets, accounts, tags, settings, rows, overview, events, toCheck, merchants].find(
      (r) => r.error,
    )?.error;
    this.loadError.set(error ? 'Dati non aggiornati: ' + error.message : '');
    if (buckets.data) this.buckets.set(buckets.data);
    if (accounts.data) this.accounts.set(accounts.data);
    if (tags.data) this.tags.set(tags.data);
    if (merchants.data) this.merchants.set(merchants.data);
    if (!settings.error) this.settings.set(settings.data);
    if (events.data && toCheck.data) this.reviewCount.set(events.data.length + toCheck.data.length);
    // Una risposta lenta di un mese già lasciato non sovrascrive quello mostrato.
    if (month === this.month()) {
      if (rows.data) this.serverRows.set(rows.data);
      if (overview.data) this.loaded.set({ month, overview: overview.data as unknown as MonthOverview });
    }
    // Un mese ancora senza righe prende quelle del mese precedente (solo online: è una scrittura).
    if ((overview.data as unknown as MonthOverview | null)?.lines.length === 0) {
      const copied = await supabase.rpc('ensure_month_lines', { p_month: month });
      if (copied.data) await this.load(month);
    }
  }
}
