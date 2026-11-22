import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { lastDay, Ledger, todayIso } from '../../core/ledger';
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

/** Testo cercato dentro un filtro PostgREST: tra virgolette, perché virgole e punti lì hanno un significato. */
const likeText = (text: string) => `"%${text.trim().replace(/["\\]/g, '')}%"`;

/** "12/11" o "12/11/2026" → data; senza anno vale quello in corso. */
export function searchDate(word: string, year = todayIso().slice(0, 4)): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(word);
  return m ? `${m[3] ?? year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/**
 * Filtro PostgREST (or) di una parola della ricerca: nome della banca, nota, esercenti, righe, conti
 * e movimenti (per i tag) trovati con quella parola, importo (in entrata o in uscita), data.
 */
export function searchFilter(text: string, merchantIds: string[], lineIds: string[], accountIds: string[] = [], txIds: string[] = []): string {
  const like = likeText(text);
  const parts = [`merchant_raw.ilike.${like}`, `note.ilike.${like}`];
  if (merchantIds.length) parts.push(`merchant_id.in.(${merchantIds.join(',')})`);
  if (lineIds.length) parts.push(`line_id.in.(${lineIds.join(',')})`);
  if (accountIds.length) parts.push(`account_id.in.(${accountIds.join(',')})`);
  if (txIds.length) parts.push(`id.in.(${txIds.join(',')})`);
  const cents = parseAmount(text);
  if (cents) parts.push(`amount_cents.in.(${cents},${-cents})`);
  const date = searchDate(text.trim());
  if (date) parts.push(`booking_date.eq.${date}`);
  return parts.join(',');
}

/** Uscite ed entrate di un giorno, separate: il netto nasconderebbe la spesa del giorno dello stipendio. I trasferimenti tra conti non contano. */
export function dayTotals(items: Transaction[]): { expense: number; income: number } {
  const sum = (sign: number) => items.filter((t) => !t.transfer_group_id && t.amount_cents * sign > 0).reduce((s, t) => s + t.amount_cents, 0);
  return { expense: sum(-1), income: sum(1) };
}

function byDay<T extends Transaction>(list: T[], withYear: boolean) {
  const days = new Map<string, T[]>();
  for (const t of list) days.set(t.booking_date, [...(days.get(t.booking_date) ?? []), t]);
  return [...days].map(([date, items]) => ({
    date,
    items,
    ...dayTotals(items),
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
      placeholder="Cerca in tutti i mesi"
      aria-label="Cerca tra i movimenti"
      [value]="query()"
      (input)="query.set($any($event.target).value)"
    />

    @if (searching()) {
      @if (searchError()) {
        <p class="warn" role="status">{{ searchError() }}</p>
      } @else if (found(); as f) {
        <p class="note" role="status">
          {{ f.length === 0 ? 'Nessun movimento trovato.' : f.length >= max ? 'I ' + max + ' più recenti' : f.length + (f.length === 1 ? ' movimento' : ' movimenti') }}
          @if (f.length) {
            · totale {{ fmt(foundTotal()) }}
          }
        </p>
      }
    } @else {
      <p class="note hint">Più parole restringono la ricerca: esercente, nota, riga, tag, conto, importo (12,50) o data (12/11).</p>
    }

    <div class="bar">
      <label class="filter">
        <input type="checkbox" [checked]="onlyUnassigned()" (change)="toggleFilter()" />
        Solo da assegnare
      </label>
      <button type="button" class="select" [class.on]="selecting()" [attr.aria-pressed]="selecting()" (click)="setSelecting(!selecting())">
        {{ selecting() ? 'Annulla selezione' : 'Seleziona' }}
      </button>
      @if (!searching()) {
        <div class="segmented" role="group" aria-label="Vista dei movimenti">
          <button type="button" [class.on]="!calendarView()" [attr.aria-pressed]="!calendarView()" (click)="setView(false)">Lista</button>
          <button type="button" [class.on]="calendarView()" [attr.aria-pressed]="calendarView()" (click)="setView(true)">Calendario</button>
        </div>
      }
    </div>

    @if (showCalendar()) {
      <div class="calendar" role="group" aria-label="Calendario del mese">
        @for (w of weekdays; track w) {
          <span class="weekday" aria-hidden="true">{{ w }}</span>
        }
        @for (c of calendar(); track $index) {
          @if (c) {
            <button
              type="button"
              class="cell"
              [class.on]="c.date === selectedDay()"
              [class.today]="c.date === today"
              [attr.aria-pressed]="c.date === selectedDay()"
              [attr.aria-label]="c.label"
              (click)="day.set(c.date === selectedDay() ? '' : c.date)"
            >
              <span class="num">{{ c.day }}</span>
              @for (name of c.names; track $index) {
                <span class="name">{{ name }}</span>
              }
              @if (c.items.length) {
                <span class="count">{{ c.items.length }} mov.</span>
                @if (c.expense) {
                  <span class="total">{{ euros(c.expense) }}</span>
                }
                @if (c.income) {
                  <span class="total in">{{ euros(c.income) }}</span>
                }
              }
            </button>
          } @else {
            <span></span>
          }
        }
      </div>
      @if (!selectedDay()) {
        <p class="note">Tocca un giorno per vedere i suoi movimenti.</p>
      } @else if (!days().length) {
        <p class="note">Nessun movimento in questo giorno.</p>
      }
    }

    @if (ledger.loadError()) {
      <p class="warn" role="status">{{ ledger.loadError() }}</p>
    }

    @for (day of days(); track day.date) {
      <section>
        <h2>
          {{ day.label }}
          <span class="day-total">
            @if (day.expense) {
              <span>{{ fmt(day.expense) }}</span>
            }
            @if (day.income) {
              <span class="in">{{ fmt(day.income) }}</span>
            }
          </span>
        </h2>
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
                  <!-- In selezione il tocco spunta il movimento invece di aprirlo. -->
                  <button
                    type="button"
                    class="row"
                    [class.picked]="selected().has(t.id)"
                    [attr.aria-pressed]="selecting() ? selected().has(t.id) : null"
                    (click)="selecting() ? toggle(t.id) : launcher.open(t)"
                  >
                    @if (selecting()) {
                      <span class="tick" aria-hidden="true">{{ selected().has(t.id) ? '✓' : '' }}</span>
                    }
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
      @if (!searching() && !showCalendar()) {
        <p class="note">{{ onlyUnassigned() ? 'Niente da assegnare in questo mese.' : 'Nessun movimento in questo mese.' }}</p>
      }
    }

    @if (selecting()) {
      <!-- Più movimenti sulla stessa riga, es. le spese di una trasferta. -->
      <div class="pick-bar" role="group" aria-label="Assegna i movimenti selezionati">
        <span role="status">{{ picked().length }} selezionati · {{ fmt(pickedTotal()) }}</span>
        <select aria-label="Riga a cui assegnarli" [value]="assignTo()" (change)="assignTo.set($any($event.target).value)">
          <option value="">Scegli la riga</option>
          @for (g of lineGroups(); track g.title) {
            <optgroup [label]="g.title">
              @for (l of g.lines; track l.id) {
                <option [value]="l.id">{{ l.name }}</option>
              }
            </optgroup>
          }
          <option value="nessuna">Da assegnare (toglie la riga)</option>
        </select>
        <button type="button" [disabled]="!picked().length || !assignTo()" (click)="assign()">Assegna</button>
      </div>
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
    .hint {
      margin: 0;
      font: var(--mat-sys-body-small);
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .segmented {
      display: flex;
    }
    .segmented button {
      min-height: 40px;
      padding: 0 14px;
      border: 1px solid var(--mat-sys-outline-variant);
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }
    .segmented button:first-child {
      border-radius: 20px 0 0 20px;
    }
    .segmented button:last-child {
      border-left: 0;
      border-radius: 0 20px 20px 0;
    }
    .segmented .on {
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    /* Sette colonne uguali: da lunedì a domenica. */
    .calendar {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 4px;
    }
    .weekday {
      font: var(--mat-sys-label-small);
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }
    .cell {
      display: grid;
      align-content: start;
      gap: 2px;
      min-height: 64px;
      padding: 4px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: var(--mat-sys-surface-container);
      color: inherit;
      font: var(--mat-sys-label-small);
      text-align: left;
      cursor: pointer;
    }
    /* Oggi è un pallino pieno: il solo colore si confondeva con quello delle entrate. */
    .cell.today .num {
      justify-self: start;
      min-width: 24px;
      border-radius: 12px;
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
      font-weight: 700;
      line-height: 24px;
      text-align: center;
    }
    .cell.on {
      border-color: var(--mat-sys-primary);
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    .cell .num {
      font: var(--mat-sys-label-large);
    }
    .cell .name,
    .cell .count {
      overflow: hidden;
      color: var(--mat-sys-on-surface-variant);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Su schermo stretto basta il numero dei movimenti; da 600 px ci stanno anche i nomi. */
    .cell .name {
      display: none;
    }
    .cell .total {
      font-weight: 600;
      white-space: nowrap;
    }
    .cell .total.in {
      color: var(--mat-sys-primary);
    }
    @media (min-width: 600px) {
      .cell {
        min-height: 88px;
        padding: 6px;
      }
      .cell .name {
        display: block;
      }
      .cell .count {
        display: none;
      }
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
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 0 12px;
      margin: 8px 0 4px;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .day-total {
      display: flex;
      gap: 12px;
      white-space: nowrap;
    }
    .day-total .in {
      color: var(--mat-sys-primary);
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
    .select,
    .pick-bar button,
    .pick-bar select {
      min-height: 40px;
      padding: 0 14px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 20px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }
    .select.on,
    .pick-bar button:not(:disabled) {
      border-color: var(--mat-sys-primary);
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    .tick {
      flex: none;
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border: 2px solid var(--mat-sys-outline);
      border-radius: 4px;
    }
    .picked .tick {
      border-color: var(--mat-sys-primary);
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
    }
    .row .text {
      flex: 1;
    }
    /* Resta in vista sopra la barra di navigazione, che su schermo stretto è fissa in basso. */
    .pick-bar {
      position: sticky;
      bottom: calc(76px + env(safe-area-inset-bottom));
      z-index: 5;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container-high);
      box-shadow: var(--mat-sys-level2);
    }
    .pick-bar select {
      flex: 1;
      min-width: 0;
    }
    @media (min-width: 840px) {
      .pick-bar {
        bottom: 12px;
      }
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

  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  protected readonly onlyUnassigned = computed(() => this.params()?.get('filtro') === 'da-assegnare');
  /** La vista sta nell'indirizzo: si ritrova tornando indietro, e la pagina Mese ci arriva diretta. */
  protected readonly calendarView = computed(() => this.params()?.get('vista') === 'calendario');
  protected readonly showCalendar = computed(() => this.calendarView() && !this.searching());
  protected readonly weekdays = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
  protected readonly today = todayIso();
  /** Giorno scelto nel calendario: all'inizio oggi; in un altro mese non vale. */
  protected readonly day = signal(this.today);
  protected readonly selectedDay = computed(() => (this.day().startsWith(this.ledger.month().slice(0, 7)) ? this.day() : ''));

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

  /** I movimenti del mese, con il filtro "da assegnare". */
  private readonly monthItems = computed(() => this.ledger.transactions().filter((t) => !this.onlyUnassigned() || this.isUnassigned(t)));

  protected readonly days = computed(() => {
    if (this.searching()) return byDay(this.found() ?? [], true);
    return byDay(this.showCalendar() ? this.monthItems().filter((t) => t.booking_date === this.selectedDay()) : this.monthItems(), false);
  });

  protected readonly foundTotal = computed(() => (this.found() ?? []).reduce((s, t) => s + t.amount_cents, 0));

  /** Selezione multipla: i movimenti spuntati tra quelli in elenco (del mese o della ricerca). */
  protected readonly selecting = signal(false);
  protected readonly selected = signal(new Set<string>());
  protected readonly assignTo = signal('');
  protected readonly picked = computed(() => (this.searching() ? (this.found() ?? []) : this.monthItems()).filter((t) => this.selected().has(t.id)));
  protected readonly pickedTotal = computed(() => this.picked().reduce((s, t) => s + t.amount_cents, 0));
  /** Le righe del mese aperto, per secchio e poi le entrate. */
  protected readonly lineGroups = computed(() => {
    const group = (title: string, bucketId: string | null) => ({ title, lines: this.ledger.lines().filter((l) => l.bucket_id === bucketId) });
    return [...this.ledger.buckets().map((b) => group(b.name, b.id)), group('Entrate', null)].filter((g) => g.lines.length);
  });

  protected setSelecting(on: boolean): void {
    this.selecting.set(on);
    this.selected.set(new Set());
    this.assignTo.set('');
  }

  protected toggle(id: string): void {
    this.selected.update((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Un movimento di un altro mese (dalla ricerca) va sulla riga con lo stesso nome nel suo mese: lo fa il database. */
  protected assign(): void {
    const line = this.ledger.lineById().get(this.assignTo());
    if (this.launcher.assign(this.picked(), line?.id ?? null, line?.name ?? 'Da assegnare')) this.setSelecting(false);
  }

  /** Le caselle del mese, da lunedì: null per i giorni vuoti prima del primo. */
  protected readonly calendar = computed(() => {
    const month = this.ledger.month();
    const offset = (new Date(month + 'T12:00:00').getDay() + 6) % 7;
    const cells = Array.from({ length: Number(lastDay(month).slice(8)) }, (_, i) => {
      const date = month.slice(0, 8) + String(i + 1).padStart(2, '0');
      const items = this.monthItems().filter((t) => t.booking_date === date);
      const totals = dayTotals(items);
      const names = items.slice(0, 2).map((t) => (t.transfer_group_id ? this.transferTitle(t) : this.title(t)));
      const label = `${i + 1}: ${items.length ? `${items.length} movimenti, uscite ${formatCents(totals.expense)}, entrate ${formatCents(totals.income)}` : 'nessun movimento'}`;
      return { date, day: i + 1, items, ...totals, names, label };
    });
    return [...Array<null>(offset).fill(null), ...cells];
  });

  /** Nel quadratino: euro interi con il segno, senza simbolo. */
  protected euros(cents: number): string {
    return Math.round(cents / 100).toLocaleString('it-IT', { signDisplay: 'exceptZero' });
  }

  protected setView(calendar: boolean): void {
    void this.router.navigate([], { queryParams: { vista: calendar ? 'calendario' : null }, queryParamsHandling: 'merge' });
  }

  constructor() {
    // Dal grafico dei giorni: il giorno da aprire arriva nell'indirizzo.
    effect(() => {
      const day = this.params()?.get('giorno');
      if (day) this.day.set(day);
    });
    // Si rifà anche dopo un salvataggio, così i risultati modificati si aggiornano.
    effect((onCleanup) => {
      const text = this.query().trim();
      this.onlyUnassigned();
      this.sync.synced();
      if (text.length < 2) return;
      const timer = setTimeout(() => untracked(() => void this.search(text)), 300);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async search(text: string): Promise<void> {
    const request = ++this.lastSearch;
    // Ogni parola deve trovarsi da qualche parte nel movimento: "amazon 12,50" restringe.
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const has = (name: string, w: string) => name.toLowerCase().includes(w);
    const tagIds = this.ledger.tags().filter((t) => words.some((w) => has(t.name, w))).map((t) => t.id);
    const [lines, tagged] = await Promise.all([
      supabase.from('budget_lines').select('id, name').or(words.map((w) => `name.ilike.${likeText(w)}`).join(',')).limit(500),
      // shortcut: al massimo 300 movimenti per tag; oltre, la ricerca per tag va spostata in una funzione del database.
      tagIds.length ? supabase.from('transaction_tags').select('transaction_id, tag_id').in('tag_id', tagIds).limit(300) : null,
    ]);
    let res: { data: unknown; error: { message: string } | null; status: number } = lines;
    if (!lines.error) {
      let q = supabase.from('transactions').select('*, transaction_tags(tag_id), budget_lines(name, bucket_id)');
      for (const w of words) {
        const ids = <T extends { id: string; name: string }>(list: T[]) => list.filter((x) => has(x.name, w)).map((x) => x.id);
        const wordTags = new Set(ids(this.ledger.tags()));
        const txIds = (tagged?.data ?? []).filter((x) => wordTags.has(x.tag_id)).map((x) => x.transaction_id);
        // Più "or" nella stessa richiesta valgono in "and".
        q = q.or(searchFilter(w, ids(this.ledger.merchants()), ids(lines.data), ids(this.ledger.accounts()), txIds));
      }
      if (this.onlyUnassigned()) q = q.is('line_id', null).is('transfer_group_id', null);
      res = await q.order('booking_date', { ascending: false }).order('occurred_at', { ascending: false }).limit(MAX_FOUND);
    }
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
      t.split_group_id ? 'diviso' : null,
      t.review_reason ? 'da controllare' : null,
      this.pendingIds().has(t.id) ? 'in attesa di invio' : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  protected toggleFilter(): void {
    void this.router.navigate([], { queryParams: { filtro: this.onlyUnassigned() ? null : 'da-assegnare' }, queryParamsHandling: 'merge' });
  }
}
