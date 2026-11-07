import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { Ledger } from '../../core/ledger';
import { formatCents, parseAmount } from '../../core/money';
import { errorText, supabase, Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { MonthHeader, SwipeMonth } from '../../shared/month-header';
import { QuickAddLauncher } from '../quick-add/quick-add';

/** Titolo di un movimento nelle liste; lineName serve per i movimenti di un mese diverso da quello caricato. */
export function movementTitle(t: Transaction, ledger: Ledger, lineName?: string): string {
  // Per i bonifici la parte che li distingue è la nota (causale e destinatario); per gli
  // addebiti PayPal la nota è solo un numero, quindi resta il nome grezzo.
  if (/^\s*bonifico\b/i.test(t.merchant_raw ?? '') && t.note) return t.note;
  return (
    ledger.merchantById().get(t.merchant_id ?? '')?.name ??
    t.merchant_raw ??
    t.note ??
    lineName ??
    ledger.lineById().get(t.line_id ?? '')?.name ??
    'Movimento'
  );
}

/** Un movimento trovato dalla ricerca, con la sua riga: può essere di un mese non caricato. */
type Found = Transaction & { budget_lines?: { name: string; bucket_id: string | null } | null };

const MAX_FOUND = 100;

/**
 * Filtro PostgREST (or) della ricerca: nome della banca, nota, esercenti e righe con quel nome,
 * importo (in entrata o in uscita). Il testo va tra virgolette: virgole e punti hanno un significato nel filtro.
 */
export function searchFilter(text: string, merchantIds: string[], lineIds: string[]): string {
  const like = `"%${text.trim().replace(/["\\]/g, '')}%"`;
  const parts = [`merchant_raw.ilike.${like}`, `note.ilike.${like}`];
  if (merchantIds.length) parts.push(`merchant_id.in.(${merchantIds.join(',')})`);
  if (lineIds.length) parts.push(`line_id.in.(${lineIds.join(',')})`);
  const cents = parseAmount(text);
  if (cents) parts.push(`amount_cents.in.(${cents},${-cents})`);
  return parts.join(',');
}

function byDay<T extends Transaction>(list: T[], withYear: boolean) {
  const days = new Map<string, T[]>();
  for (const t of list) days.set(t.booking_date, [...(days.get(t.booking_date) ?? []), t]);
  return [...days].map(([date, items]) => ({
    date,
    items,
    label: new Date(date + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: withYear ? 'numeric' : undefined }),
  }));
}

@Component({
  selector: 'app-transactions',
  imports: [MonthHeader],
  hostDirectives: [SwipeMonth],
  template: `
    <app-month-header />

    <input
      class="search"
      type="search"
      autocomplete="off"
      placeholder="Cerca in tutti i mesi: esercente, nota, riga, importo"
      aria-label="Cerca tra i movimenti"
      [value]="query()"
      (input)="query.set($any($event.target).value)"
    />

    @if (searching()) {
      @if (searchError()) {
        <p class="warn" role="status">{{ searchError() }}</p>
      } @else if (found(); as f) {
        <p class="note" role="status">
          {{ f.length === 0 ? 'Nessun movimento trovato.' : f.length >= max ? 'I ' + max + ' più recenti:' : f.length + (f.length === 1 ? ' movimento' : ' movimenti') }}
        </p>
      }
    } @else {
      <label class="filter">
        <input type="checkbox" [checked]="onlyUnassigned()" (change)="toggleFilter()" />
        Solo da assegnare
      </label>
    }

    @if (ledger.loadError()) {
      <p class="warn" role="status">{{ ledger.loadError() }}</p>
    }

    @for (day of days(); track day.date) {
      <section>
        <h2>{{ day.label }}</h2>
        <ul>
          @for (t of day.items; track t.id) {
            <li>
              @if (t.transfer_group_id) {
                <!-- Non si modifica una riga sola: si elimina il trasferimento intero e lo si rifà. -->
                <div class="swipe">
                  <div class="row">
                    <span class="text">
                      <span class="title">{{ transferTitle(t) }}</span>
                      <span class="sub">{{ ledger.accountById().get(t.account_id)?.name }}</span>
                    </span>
                    <span class="amount">{{ fmt(t.amount_cents) }}</span>
                  </div>
                  <button type="button" class="delete" (click)="launcher.remove(t)">Elimina</button>
                </div>
              } @else {
                <div class="swipe">
                  <button type="button" class="row" (click)="launcher.open(t)">
                    <span class="text">
                      <span class="title">{{ title(t) }}</span>
                      <span class="sub" [class.todo]="isUnassigned(t)">{{ subtitle(t) }}</span>
                    </span>
                    <span class="amount" [class.in]="t.amount_cents > 0">{{ fmt(t.amount_cents) }}</span>
                  </button>
                  <button type="button" class="delete" (click)="launcher.remove(t)">Elimina</button>
                </div>
              }
            </li>
          }
        </ul>
      </section>
    } @empty {
      @if (!searching()) {
        <p class="note">{{ onlyUnassigned() ? 'Niente da assegnare in questo mese.' : 'Nessun movimento in questo mese.' }}</p>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 12px;
    }
    .search {
      min-height: 44px;
      padding: 0 12px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 22px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    .filter {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
    }
    .filter input {
      width: 22px;
      height: 22px;
    }
    h2 {
      margin: 8px 0 4px;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .swipe {
      display: flex;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
    }
    .swipe::-webkit-scrollbar {
      display: none;
    }
    .row {
      flex: 0 0 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      min-height: 56px;
      padding: 6px 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      scroll-snap-align: start;
      cursor: pointer;
    }
    .text {
      display: grid;
      min-width: 0;
    }
    .title,
    .sub {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .sub.todo {
      color: var(--mat-sys-tertiary);
    }
    .amount {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .amount.in {
      color: var(--mat-sys-primary);
    }
    .delete {
      flex: 0 0 96px;
      border: 0;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font: var(--mat-sys-label-large);
      scroll-snap-align: end;
      cursor: pointer;
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .note {
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class Transactions {
  protected readonly ledger = inject(Ledger);
  protected readonly launcher = inject(QuickAddLauncher);
  private readonly sync = inject(Sync);
  private readonly router = inject(Router);
  protected readonly fmt = formatCents;

  protected readonly onlyUnassigned = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((p) => p.get('filtro') === 'da-assegnare')),
    { initialValue: false },
  );

  private readonly pendingIds = computed(
    () => new Set(this.sync.ops().flatMap((op) => (op.kind === 'upsert' ? [op.row['id']] : []))),
  );

  /** Ricerca su tutti i mesi, nel database: con almeno due caratteri sostituisce la lista del mese. */
  protected readonly query = signal('');
  protected readonly searching = computed(() => this.query().trim().length >= 2);
  protected readonly found = signal<Found[] | null>(null);
  protected readonly searchError = signal('');
  protected readonly max = MAX_FOUND;
  private lastSearch = 0;

  protected readonly days = computed(() => {
    if (this.searching()) return byDay(this.found() ?? [], true);
    return byDay(this.ledger.transactions().filter((t) => !this.onlyUnassigned() || this.isUnassigned(t)), false);
  });

  constructor() {
    // Si rifà anche dopo un salvataggio, così i risultati modificati si aggiornano.
    effect((onCleanup) => {
      const text = this.query().trim();
      this.sync.synced();
      if (text.length < 2) return;
      const timer = setTimeout(() => untracked(() => void this.search(text)), 300);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async search(text: string): Promise<void> {
    const request = ++this.lastSearch;
    const lower = text.toLowerCase();
    const merchantIds = this.ledger.merchants().filter((m) => m.name.toLowerCase().includes(lower)).map((m) => m.id);
    const lines = await supabase.from('budget_lines').select('id').ilike('name', `%${text}%`).limit(200);
    const res = lines.error
      ? lines
      : await supabase
          .from('transactions')
          .select('*, transaction_tags(tag_id), budget_lines(name, bucket_id)')
          .or(searchFilter(text, merchantIds, lines.data.map((l) => l.id)))
          .order('booking_date', { ascending: false })
          .order('occurred_at', { ascending: false })
          .limit(MAX_FOUND);
    // Una risposta lenta di una ricerca superata non sovrascrive quella mostrata.
    if (request !== this.lastSearch) return;
    this.searchError.set(res.error ? 'Ricerca non riuscita: ' + errorText(res) : '');
    if (!res.error) this.found.set(res.data as Found[]);
  }

  protected isUnassigned(t: Transaction): boolean {
    return !t.transfer_group_id && !t.line_id;
  }

  protected transferTitle(t: Transaction): string {
    if (!t.line_id) return 'Trasferimento';
    return t.amount_cents < 0 ? 'Accantonamento' : 'Prelievo dalla riserva';
  }

  protected title(t: Found): string {
    return movementTitle(t, this.ledger, t.budget_lines?.name);
  }

  protected subtitle(t: Found): string {
    const line = t.budget_lines ?? this.ledger.lineById().get(t.line_id ?? '');
    const bucket = this.ledger.bucketById().get(line?.bucket_id ?? '');
    const tags = (t.transaction_tags ?? []).map((x) => this.ledger.tagById().get(x.tag_id)?.name).filter(Boolean);
    const parts = [
      this.isUnassigned(t) ? 'Da assegnare' : line?.name,
      line && !line.bucket_id ? 'Entrate' : bucket?.name,
      ...tags,
      t.review_reason ? 'da controllare' : null,
      this.pendingIds().has(t.id) ? 'in attesa di invio' : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  protected toggleFilter(): void {
    void this.router.navigate([], { queryParams: { filtro: this.onlyUnassigned() ? null : 'da-assegnare' } });
  }
}
