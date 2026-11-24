import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { italianDate } from '../../core/files';
import { currentMonth, Ledger, todayIso } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { MonthOverview, supabase, Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { PAGE_STYLES } from '../../shared/page-styles';
import { QuickAddLauncher } from '../quick-add/quick-add';
import { movementTitle } from '../transactions/transactions';
import { BankRow, BOOKING_LAG, reconcile } from './reconcile';

/** Risposta della funzione "banca". */
interface BankState {
  available_cents: number | null;
  valid_until: string;
  from: string;
  transactions: BankRow[];
}

// La banca limita le letture: tornando sulla pagina entro pochi minuti si riusa l'ultima risposta.
let cache: { at: number; state: BankState } | null = null;
const CACHE_MS = 10 * 60_000;

/** Confronto con la banca: saldo disponibile e movimenti che mancano da una parte o dall'altra. Solo online. */
@Component({
  selector: 'app-bank',
  imports: [MatButtonModule],
  template: `
    <h1>Banca</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: il confronto con la banca serve la connessione.</p>
    }
    @if (error()) {
      <p class="warn" role="alert">{{ error() }}</p>
    }

    @if (bank(); as b) {
      <section class="card" aria-label="Saldo disponibile">
        <span class="label">Disponibile in banca</span>
        <strong>{{ b.available_cents === null ? '—' : fmt(b.available_cents) }}</strong>
        <span class="label">Nell'app: {{ appBalance() === null ? '—' : fmt(appBalance()!) }} · {{ verdict() }}</span>
      </section>

      @if (result(); as r) {
        <h2>In banca ma non nell'app ({{ r.missing.length }})</h2>
        <ul>
          @for (m of r.missing; track m.ref) {
            <li>
              <div class="line">
                <strong>{{ m.text }}</strong>
                <span class="num">{{ fmt(m.amount_cents) }}</span>
              </div>
              <span class="sub">
                {{ date(m.value_date) }}{{ m.booking_date === m.value_date ? '' : ' · contabilizzato il ' + date(m.booking_date) }}
              </span>
              <div class="actions">
                @if (isTransfer(m)) {
                  <button mat-stroked-button type="button" (click)="launcher.openTransfer()">Trasferisci</button>
                } @else {
                  <button mat-stroked-button type="button" (click)="add(m)">Aggiungi</button>
                }
              </div>
            </li>
          } @empty {
            <p class="note">Nessuno: i movimenti della banca sono tutti nell'app.</p>
          }
        </ul>

        <h2>Nell'app ma non in banca ({{ r.unknown.length }})</h2>
        <ul>
          @for (t of r.unknown; track t.id) {
            <li>
              <div class="line">
                <strong>{{ title(t) }}</strong>
                <span class="num">{{ fmt(t.amount_cents) }}</span>
              </div>
              <span class="sub">{{ date(t.booking_date) }}</span>
              <div class="actions">
                <button mat-stroked-button type="button" (click)="launcher.open(t)">Apri</button>
              </div>
            </li>
          } @empty {
            <p class="note">Nessuno.</p>
          }
        </ul>

        <p class="note">
          Confronto dal {{ date(b.from) }}, solo sui movimenti che la banca ha già contabilizzato.
          @if (r.waiting) {
            {{ r.waiting }} {{ r.waiting === 1 ? 'movimento' : 'movimenti' }} degli ultimi {{ lag }} giorni non
            {{ r.waiting === 1 ? 'è' : 'sono' }} ancora in banca: è normale.
          }
        </p>
      }
      <p class="note">Letto alle {{ readAt() }} · consenso valido fino al {{ date(b.valid_until.slice(0, 10)) }}</p>
    }

    <div class="actions">
      <button mat-flat-button type="button" [disabled]="!online() || busy()" (click)="load(true)">
        {{ busy() ? 'Lettura…' : 'Aggiorna' }}
      </button>
    </div>
  `,
  styles: [PAGE_STYLES],
})
export class Bank {
  private readonly ledger = inject(Ledger);
  private readonly sync = inject(Sync);
  protected readonly launcher = inject(QuickAddLauncher);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly date = italianDate;
  protected readonly lag = BOOKING_LAG;

  protected readonly bank = signal<BankState | null>(null);
  protected readonly readAt = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  private readonly rows = signal<Transaction[] | null>(null);
  protected readonly appBalance = signal<number | null>(null);

  protected readonly result = computed(() => {
    const bank = this.bank();
    const rows = this.rows();
    return bank && rows ? reconcile(bank.transactions, rows, bank.from, todayIso()) : null;
  });

  protected readonly verdict = computed(() => {
    const bank = this.bank()?.available_cents ?? null;
    const app = this.appBalance();
    if (bank === null || app === null) return 'non confrontabile';
    return bank === app ? 'allineato' : `in banca ${formatCents(Math.abs(bank - app))} in ${bank > app ? 'più' : 'meno'}`;
  });

  constructor() {
    void this.load(false);
    // Dopo ogni invio (un movimento aggiunto o corretto da qui) il confronto si rifà, senza richiamare la banca.
    effect(() => {
      if (this.sync.synced()) untracked(() => void this.loadApp());
    });
  }

  protected title(t: Transaction): string {
    return movementTitle(t, this.ledger);
  }

  /** Arrotondamenti e spostamenti col Salvadanaio: nell'app sono trasferimenti, non spese. */
  protected isTransfer(m: BankRow): boolean {
    return m.kind.startsWith('TRASPASO');
  }

  protected add(m: BankRow): void {
    this.launcher.open(undefined, {
      cents: Math.abs(m.amount_cents),
      note: m.text,
      bucketId: null,
      income: m.amount_cents > 0,
      date: m.value_date,
    });
  }

  protected async load(force: boolean): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      if (force || !cache || Date.now() - cache.at > CACHE_MS) {
        const res = await supabase.functions.invoke<BankState>('banca');
        if (res.error) {
          // Il messaggio della funzione sta nel corpo della risposta, non nell'errore.
          const body = await (res.error.context as Response | undefined)?.json?.().catch(() => null);
          throw new Error(body?.message ?? 'La banca non è raggiungibile');
        }
        cache = { at: Date.now(), state: res.data! };
      }
      this.bank.set(cache.state);
      this.readAt.set(new Date(cache.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
      await this.loadApp();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** I movimenti dell'app da confrontare e il disponibile, come lo mostra la pagina Mese. */
  private async loadApp(): Promise<void> {
    const bank = this.bank();
    if (!bank) return;
    const accounts = await supabase.from('accounts').select('id, name').eq('role', 'spendable').eq('archived', false).order('sort_order');
    // shortcut: un solo conto in banca; con più conti spendibili vale quello che si chiama BBVA, altrimenti il primo.
    const account = accounts.data?.find((a) => /bbva/i.test(a.name)) ?? accounts.data?.[0];
    if (!account) return;
    // Più indietro della banca: la notifica di un pagamento può precedere di giorni la contabilizzazione.
    const since = new Date(Date.parse(bank.from) - 13 * 86400e3).toISOString().slice(0, 10);
    const [rows, overview] = await Promise.all([
      supabase.from('transactions').select('*, transaction_tags(tag_id)').eq('account_id', account.id).gte('booking_date', since),
      supabase.rpc('month_overview', { p_month: currentMonth() }, { get: true }),
    ]);
    if (rows.error || overview.error) {
      this.error.set('Movimenti dell\'app non letti: ' + (rows.error ?? overview.error)!.message);
      return;
    }
    this.rows.set(rows.data);
    this.appBalance.set((overview.data as unknown as MonthOverview).end_actual);
  }
}
