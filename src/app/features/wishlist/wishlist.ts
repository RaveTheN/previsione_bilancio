import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { bucketLeft } from '../../core/budget';
import { italianDate } from '../../core/files';
import { currentMonth, Ledger, monthLabel } from '../../core/ledger';
import { centsToInput, formatCents, parseAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, MonthOverview, supabase, WishlistItem } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { PAGE_STYLES } from '../../shared/page-styles';
import { QuickAddLauncher } from '../quick-add/quick-add';

type Item = WishlistItem & { transactions: { booking_date: string } | null };

const PRIORITIES = [
  { value: 1, label: 'Alta' },
  { value: 2, label: 'Media' },
  { value: 3, label: 'Bassa' },
];

/** Lista dei desideri: il semaforo guarda quanto resta del secchio scelto, nel mese in corso. Solo online. */
@Component({
  selector: 'app-wishlist',
  imports: [FormsModule, MatButtonModule, RouterLink],
  template: `
    <h1>Lista dei desideri</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: la lista si modifica solo con la connessione.</p>
    }

    @if (bucket(); as b) {
      <section class="card" aria-label="Budget del mese">
        <span class="label">{{ b.name }}: quanto resta a {{ month }}</span>
        <strong>{{ left() === null ? '—' : fmt(left()!) }}</strong>
      </section>
    } @else {
      <p class="note">Per il semaforo scegli il secchio dei desideri in <a routerLink="/altro">Altro</a>.</p>
    }

    <fieldset [disabled]="!online()">
      <ul>
        @for (w of toBuy(); track w.id) {
          <li>
            <div class="line">
              <strong>{{ w.name }}</strong>
              <span class="num">{{ fmt(w.price_cents) }}</span>
            </div>
            <span class="sub">Priorità {{ priority(w).toLowerCase() }}{{ w.note ? ' · ' + w.note : '' }}</span>
            @if (left() !== null) {
              <!-- Mai solo il colore: il testo dice già tutto. -->
              @if (w.price_cents <= left()!) {
                <span class="yes">✓ Puoi permettertelo</span>
              } @else {
                <span class="warn">✕ Oltre il budget di {{ fmt(w.price_cents - left()!) }}</span>
              }
            }
            <div class="actions">
              <button mat-flat-button type="button" (click)="buy(w)">L'ho comprato</button>
              <button mat-stroked-button type="button" (click)="edit(w)">Modifica</button>
              <button mat-button type="button" (click)="remove(w)">Elimina</button>
            </div>
          </li>
        } @empty {
          <p class="note">Nessun desiderio da comprare.</p>
        }
      </ul>

      @if (bought().length) {
        <section>
          <h2>Comprati</h2>
          <ul>
            @for (w of bought(); track w.id) {
              <li>
                <div class="line">
                  <span>{{ w.name }}</span>
                  <span class="num">{{ fmt(w.price_cents) }}</span>
                </div>
                <span class="sub">Comprato il {{ date(w.transactions?.booking_date ?? '') }}</span>
                <div class="actions">
                  <button mat-button type="button" (click)="remove(w)">Togli dalla lista</button>
                </div>
              </li>
            }
          </ul>
        </section>
      }

      <form (ngSubmit)="save()">
        <h2>{{ editing() ? 'Modifica desiderio' : 'Nuovo desiderio' }}</h2>
        <label>Nome <input name="name" autocomplete="off" placeholder="Es. Cuffie" [(ngModel)]="name" /></label>
        <label>Prezzo (€) <input name="price" inputmode="decimal" autocomplete="off" placeholder="0,00" [(ngModel)]="priceText" /></label>
        <label>
          Priorità
          <select name="priority" [(ngModel)]="priorityValue">
            @for (p of priorities; track p.value) {
              <option [ngValue]="p.value">{{ p.label }}</option>
            }
          </select>
        </label>
        <label>Nota <input name="note" autocomplete="off" [(ngModel)]="note" /></label>
        <div class="actions">
          @if (editing()) {
            <button mat-button type="button" (click)="reset()">Annulla</button>
          }
          <button mat-flat-button type="submit">Salva</button>
        </div>
      </form>
    </fieldset>
  `,
  styles: [
    PAGE_STYLES,
    `
      .yes {
        color: light-dark(#15803d, #4ade80);
      }
    `,
  ],
})
export class Wishlist {
  private readonly ledger = inject(Ledger);
  private readonly sync = inject(Sync);
  private readonly launcher = inject(QuickAddLauncher);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly date = italianDate;
  protected readonly priorities = PRIORITIES;
  protected readonly month = monthLabel(currentMonth()).toLowerCase();
  private readonly items = signal<Item[]>([]);
  private readonly overview = signal<MonthOverview | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected name = '';
  protected priceText = '';
  protected priorityValue = 2;
  protected note = '';

  protected readonly toBuy = computed(() => this.items().filter((w) => !w.transaction_id));
  protected readonly bought = computed(() => this.items().filter((w) => w.transaction_id));
  protected readonly bucket = computed(() => this.ledger.bucketById().get(this.ledger.settings()?.wishlist_bucket_id ?? ''));
  protected readonly left = computed(() => {
    const bucket = this.bucket();
    const overview = this.overview();
    return bucket && overview ? bucketLeft(overview.lines, bucket.id) : null;
  });

  constructor() {
    // Si ricarica anche dopo ogni invio della coda: annullare un acquisto lo rimette da comprare.
    effect(() => {
      this.sync.synced();
      untracked(() => void this.load());
    });
  }

  protected priority(w: WishlistItem): string {
    return PRIORITIES.find((p) => p.value === w.priority)?.label ?? '';
  }

  /** Apre l'inserimento rapido già compilato; salvata la spesa, la collega al desiderio. */
  protected buy(w: Item): void {
    const draft = { cents: w.price_cents, note: w.name, bucketId: this.bucket()?.id ?? null };
    this.launcher.open(undefined, draft, async (id) => {
      await this.sync.flush();
      this.done(await supabase.from('wishlist_items').update({ transaction_id: id }).eq('id', w.id), 'Spesa salvata, ma non collegata al desiderio');
    });
  }

  protected edit(w: Item): void {
    this.editing.set(w.id);
    this.name = w.name;
    this.priceText = centsToInput(w.price_cents);
    this.priorityValue = w.priority;
    this.note = w.note ?? '';
  }

  protected reset(): void {
    this.editing.set(null);
    this.name = this.priceText = this.note = '';
    this.priorityValue = 2;
  }

  protected async save(): Promise<void> {
    const price = parseAmount(this.priceText);
    if (!this.name.trim() || !price) {
      this.snackBar.open('Servono nome e prezzo', 'OK', { duration: 5000 });
      return;
    }
    const row = { name: this.name.trim(), price_cents: price, priority: this.priorityValue, note: this.note.trim() || null };
    const id = this.editing();
    const res = id ? await supabase.from('wishlist_items').update(row).eq('id', id) : await supabase.from('wishlist_items').insert(row);
    if (!res.error) this.reset();
    this.done(res, 'Desiderio non salvato');
  }

  protected async remove(w: Item): Promise<void> {
    if (!confirm(`Togliere "${w.name}" dalla lista?${w.transaction_id ? ' La spesa resta.' : ''}`)) return;
    this.done(await supabase.from('wishlist_items').delete().eq('id', w.id), 'Desiderio non eliminato');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load();
  }

  private async load(): Promise<void> {
    const [items, overview] = await Promise.all([
      supabase.from('wishlist_items').select('*, transactions(booking_date)').order('priority').order('created_at'),
      // In GET: il service worker la conserva per la lettura offline.
      supabase.rpc('month_overview', { p_month: currentMonth() }, { get: true }),
    ]);
    if (items.data) this.items.set(items.data as unknown as Item[]);
    if (overview.data) this.overview.set(overview.data as unknown as MonthOverview);
  }
}
