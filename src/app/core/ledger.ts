import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Auth } from './auth';
import { applyPending } from './queue';
import { Account, Bucket, Category, MonthActual, supabase, Tag, Transaction } from './supabase';
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

export function monthLabel(month: string): string {
  const label = new Date(month + 'T12:00:00').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Dati del mese selezionato e dati di riferimento (categorie, secchi, conti, tag). */
@Injectable({ providedIn: 'root' })
export class Ledger {
  private readonly auth = inject(Auth);
  private readonly sync = inject(Sync);

  readonly month = signal(currentMonth());
  readonly categories = signal<Category[]>([]);
  readonly buckets = signal<Bucket[]>([]);
  readonly accounts = signal<Account[]>([]);
  readonly tags = signal<Tag[]>([]);
  readonly actuals = signal<MonthActual[]>([]);
  readonly loadError = signal('');
  private readonly serverRows = signal<Transaction[]>([]);

  /** Movimenti del mese, compresi quelli ancora in coda. */
  readonly transactions = computed(() =>
    applyPending(this.serverRows(), this.sync.ops())
      .filter((t) => t.booking_date?.startsWith(this.month().slice(0, 7)))
      .sort((a, b) => b.booking_date.localeCompare(a.booking_date) || b.occurred_at.localeCompare(a.occurred_at)),
  );

  readonly categoryById = computed(() => new Map(this.categories().map((c) => [c.id, c])));
  readonly bucketById = computed(() => new Map(this.buckets().map((b) => [b.id, b])));
  readonly accountById = computed(() => new Map(this.accounts().map((a) => [a.id, a])));
  readonly tagById = computed(() => new Map(this.tags().map((t) => [t.id, t])));

  constructor() {
    effect(() => {
      const month = this.month();
      this.sync.synced();
      if (this.auth.session()) untracked(() => void this.load(month));
    });
  }

  async load(month = this.month()): Promise<void> {
    const [cats, buckets, accounts, tags, rows, actuals] = await Promise.all([
      supabase.from('categories').select().order('sort_order'),
      supabase.from('buckets').select().order('sort_order'),
      supabase.from('accounts').select().order('sort_order'),
      supabase.from('tags').select().order('name'),
      supabase.from('transactions').select('*, transaction_tags(tag_id)').eq('month', month),
      supabase.from('month_actuals').select().eq('month', month),
    ]);
    const error = [cats, buckets, accounts, tags, rows, actuals].find((r) => r.error)?.error;
    this.loadError.set(error ? 'Dati non aggiornati: ' + error.message : '');
    if (cats.data) this.categories.set(cats.data);
    if (buckets.data) this.buckets.set(buckets.data);
    if (accounts.data) this.accounts.set(accounts.data);
    if (tags.data) this.tags.set(tags.data);
    if (month === this.month()) {
      if (rows.data) this.serverRows.set(rows.data);
      if (actuals.data) this.actuals.set(actuals.data);
    }
  }
}
