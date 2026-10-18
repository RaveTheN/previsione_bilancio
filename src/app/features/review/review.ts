import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Ledger } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, IngestEvent, supabase, Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { QuickAddLauncher } from '../quick-add/quick-add';

/** Notifiche non riconosciute e movimenti da controllare, di tutti i mesi. */
@Component({
  selector: 'app-review',
  imports: [MatButtonModule, RouterLink],
  template: `
    <h1>Da rivedere</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: vedi l'ultimo elenco scaricato, le azioni richiedono la connessione.</p>
    }

    <section>
      <h2>Notifiche non riconosciute</h2>
      <ul>
        @for (e of events(); track e.id) {
          <li>
            <span class="sub">{{ e.app }} · {{ when(e.occurred_at) }}</span>
            <!-- Testo della notifica: solo testo, mai HTML. -->
            <span class="text">{{ text(e) }}</span>
            @if (e.error) {
              <span class="warn">{{ e.error }}</span>
            }
            <div class="actions">
              <button mat-stroked-button type="button" [disabled]="!online()" (click)="retry(e)">Riprova</button>
              <button mat-button type="button" [disabled]="!online()" (click)="dismiss(e)">Elimina</button>
            </div>
          </li>
        } @empty {
          <p class="note">Nessuna.</p>
        }
      </ul>
    </section>

    <section>
      <h2>Movimenti da controllare</h2>
      <ul>
        @for (t of txs(); track t.id) {
          <li>
            <div class="line">
              <span>{{ t.merchant_raw ?? t.note ?? 'Movimento' }}</span>
              <span class="amount">{{ fmt(t.amount_cents) }}</span>
            </div>
            <span class="sub">{{ day(t.booking_date) }} · {{ ledger.accountById().get(t.account_id)?.name }}</span>
            <span class="warn">{{ t.review_reason ?? 'Da confermare' }}</span>
            <div class="actions">
              <button mat-stroked-button type="button" (click)="launcher.open(t)">Modifica</button>
              <button mat-button type="button" [disabled]="!online()" (click)="accept(t)">Va bene così</button>
            </div>
          </li>
        } @empty {
          <p class="note">Nessuno.</p>
        }
      </ul>
    </section>

    <a routerLink="/movimenti" [queryParams]="{ filtro: 'da-assegnare' }">Movimenti da assegnare del mese</a>
  `,
  styles: `
    :host {
      display: grid;
      gap: 24px;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-title-large);
    }
    h2 {
      margin: 0 0 8px;
      font: var(--mat-sys-title-medium);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: grid;
      gap: 4px;
      padding: 8px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .text {
      overflow-wrap: anywhere;
    }
    .amount {
      white-space: nowrap;
    }
    .sub {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .actions button {
      min-height: 44px;
    }
    a {
      display: flex;
      align-items: center;
      min-height: 44px;
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .note {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class Review {
  protected readonly ledger = inject(Ledger);
  protected readonly launcher = inject(QuickAddLauncher);
  private readonly snackBar = inject(MatSnackBar);
  private readonly sync = inject(Sync);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly events = signal<IngestEvent[]>([]);
  protected readonly txs = signal<Transaction[]>([]);

  constructor() {
    // Si ricarica anche dopo ogni invio della coda (es. una modifica fatta da qui).
    effect(() => {
      this.sync.synced();
      untracked(() => void this.load());
    });
  }

  protected text(e: IngestEvent): string {
    return [e.title, e.subtitle, e.body].filter(Boolean).join(' · ') || 'Testo cancellato dopo 90 giorni';
  }

  protected when(iso: string): string {
    return new Date(iso).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  protected day(date: string): string {
    return new Date(date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
  }

  protected async retry(e: IngestEvent): Promise<void> {
    const res = await supabase.rpc('reprocess_event', { p_event_id: e.id });
    const message = (res.data as { message?: string } | null)?.message;
    this.snackBar.open(res.error ? 'Non riuscito: ' + errorText(res) : (message ?? 'Fatto'), 'OK', { duration: 5000 });
    await this.load();
  }

  protected async dismiss(e: IngestEvent): Promise<void> {
    this.done(await supabase.from('ingest_events').delete().eq('id', e.id), 'Non eliminata');
  }

  protected async accept(t: Transaction): Promise<void> {
    this.done(
      await supabase.from('transactions').update({ review_reason: null, status: 'confirmed' }).eq('id', t.id),
      'Non salvato',
    );
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load();
  }

  private async load(): Promise<void> {
    const [events, txs] = await Promise.all([
      supabase
        .from('ingest_events')
        .select()
        .in('status', ['unrecognized', 'error'])
        .is('transaction_id', null)
        .order('occurred_at', { ascending: false }),
      supabase
        .from('transactions')
        .select('*, transaction_tags(tag_id)')
        .or('review_reason.not.is.null,status.eq.pending')
        .order('booking_date', { ascending: false }),
    ]);
    if (events.data) this.events.set(events.data);
    if (txs.data) this.txs.set(txs.data);
    void this.ledger.load();
  }
}
