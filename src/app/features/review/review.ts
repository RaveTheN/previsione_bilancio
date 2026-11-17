import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Ledger } from '../../core/ledger';
import { formatCents, parseAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, IngestEvent, ParseRule, supabase, Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { QuickAddLauncher } from '../quick-add/quick-add';

/** La notifica con la sua regola: se la regola non legge l'importo, si scrive qui. */
type ReviewEvent = IngestEvent & { parse_rules: Pick<ParseRule, 'action' | 'amount_regex' | 'line_name'> | null };

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
            @if (e.parse_rules; as rule) {
              @if (!rule.amount_regex && rule.action !== 'ignore') {
                <div class="actions">
                  <input #amount inputmode="decimal" autocomplete="off" placeholder="0,00" [attr.aria-label]="'Importo per ' + (rule.line_name ?? 'il movimento')" />
                  <button mat-flat-button type="button" [disabled]="!online()" (click)="complete(e, amount.value)">
                    {{ rule.line_name ? 'Aggiungi a ' + rule.line_name : 'Crea movimento' }}
                  </button>
                </div>
              }
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
      @if (events().length) {
        <div class="actions tools">
          <a mat-button routerLink="/regole">Regole notifiche</a>
          <button mat-button type="button" [disabled]="!online()" (click)="dismissAll()">Elimina tutte</button>
          <button mat-stroked-button type="button" [disabled]="!online()" (click)="retryAll()">Riprova tutte</button>
        </div>
      }
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
      margin-bottom: 8px;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
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
      flex-wrap: wrap;
      gap: 8px;
    }
    .actions button,
    .actions a,
    .actions input {
      min-height: 44px;
    }
    .actions input {
      width: 7em;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    .tools {
      justify-content: flex-end;
      margin-top: 8px;
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
  protected readonly events = signal<ReviewEvent[]>([]);
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

  protected async retryAll(): Promise<void> {
    const res = await supabase.rpc('reprocess_events');
    const counts = res.data as { riconosciute: number; ancora_da_rivedere: number } | null;
    this.snackBar.open(
      res.error ? 'Non riuscito: ' + errorText(res) : `Riconosciute ${counts?.riconosciute}, ancora da rivedere ${counts?.ancora_da_rivedere}`,
      'OK',
      { duration: 5000 },
    );
    await this.load();
  }

  protected async complete(e: IngestEvent, text: string): Promise<void> {
    const cents = parseAmount(text);
    if (cents === null) {
      this.snackBar.open('Scrivi un importo, es. 2,27', 'OK', { duration: 3000 });
      return;
    }
    this.done(await supabase.rpc('complete_event', { p_event_id: e.id, p_amount_cents: cents }), 'Non salvato');
  }

  protected async dismiss(e: IngestEvent): Promise<void> {
    this.done(await supabase.from('ingest_events').delete().eq('id', e.id), 'Non eliminata');
  }

  /** Solo quelle in elenco: una notifica arrivata nel frattempo resta. */
  protected async dismissAll(): Promise<void> {
    const ids = this.events().map((e) => e.id);
    if (!confirm(`Eliminare ${ids.length === 1 ? 'la notifica' : `tutte le ${ids.length} notifiche`} da rivedere? Non si recuperano.`)) return;
    this.done(await supabase.from('ingest_events').delete().in('id', ids), 'Non eliminate');
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
        .select('*, parse_rules(action, amount_regex, line_name)')
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
