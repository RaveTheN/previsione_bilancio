import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { copyForecast, forecastToInput, inputToForecast, signedText, writeForecast } from '../../core/budget';
import { currentMonth, Ledger, monthLabel, shiftMonth } from '../../core/ledger';
import { deviation, formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, MonthOverview, supabase, Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { QuickAddLauncher } from '../quick-add/quick-add';
import { movementTitle } from '../transactions/transactions';
import { Cell, GridRow, pivotYear } from './pivot';

type Density = 'compatta' | 'dettagliata';
const DENSITY_KEY = 'bilancio.densita-griglia';
const number = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Scelta salvata per dispositivo; senza scelta, dettagliata solo sugli schermi larghi. */
function readDensity(): Density {
  try {
    const saved = localStorage.getItem(DENSITY_KEY);
    if (saved === 'compatta' || saved === 'dettagliata') return saved;
  } catch {
    // storage non disponibile: vale il default
  }
  return window.innerWidth >= 1440 ? 'dettagliata' : 'compatta';
}

/** Vista annuale a griglia, per PC e iPad. Su iPhone resta la vista mese. */
@Component({
  selector: 'app-year',
  imports: [FormsModule, MatButtonModule, NgTemplateOutlet],
  host: { '(keydown.escape)': 'selected.set(null)' },
  template: `
    <header class="bar">
      <button type="button" class="nav" aria-label="Anno precedente" (click)="year.set(year() - 1)">
        <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z" /></svg>
      </button>
      <h1>{{ year() }}</h1>
      <button type="button" class="nav" aria-label="Anno successivo" (click)="year.set(year() + 1)">
        <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" /></svg>
      </button>
      <div class="segmented" role="group" aria-label="Densità della griglia">
        @for (d of densities; track d) {
          <button type="button" [class.on]="density() === d" [attr.aria-pressed]="density() === d" (click)="setDensity(d)">
            {{ d === 'compatta' ? 'Compatta' : 'Dettagliata' }}
          </button>
        }
      </div>
    </header>

    @if (loadError()) {
      <p class="warn" role="status">{{ loadError() }}</p>
    }
    <p class="note">
      Importi in euro, uscite in negativo.
      @if (detailed()) {
        P previsto, E effettivo, Δ differenza: + e ↑ meglio del previsto, − e ↓ peggio.
      } @else {
        Mesi passati: effettivo (↑ meglio, ↓ peggio del previsto); mesi futuri: previsto, in corsivo.
      }
      @if (detailed() && !online()) {
        <span class="warn">Offline: la previsione si modifica solo con la connessione.</span>
      }
    </p>

    <div class="layout" [class.with-panel]="!!selectedRow()">
      <div class="wrap" tabindex="0" aria-label="Griglia dell'anno">
        @if (pivot(); as p) {
          <table [class.detailed]="detailed()">
            <thead>
              <tr>
                <th scope="col" class="corner" [attr.rowspan]="detailed() ? 2 : 1">Voce</th>
                @for (m of months(); track m) {
                  <th scope="col" [attr.colspan]="detailed() ? 3 : 1" [class.cur]="m === current">{{ short(m) }}</th>
                }
                <th scope="col" [attr.colspan]="detailed() ? 3 : 1">Anno</th>
              </tr>
              @if (detailed()) {
                <tr class="sub">
                  @for (m of columns; track $index) {
                    <th scope="col"><abbr title="Previsto">P</abbr></th>
                    <th scope="col"><abbr title="Effettivo">E</abbr></th>
                    <th scope="col"><abbr title="Differenza">Δ</abbr></th>
                  }
                </tr>
              }
            </thead>

            @for (g of p.groups; track g.key) {
              <tbody>
                <tr class="group">
                  <th scope="rowgroup">
                    <button type="button" class="toggle" [attr.aria-expanded]="!collapsed().has(g.key)" (click)="toggle(g.key)">
                      {{ collapsed().has(g.key) ? '▸' : '▾' }} {{ g.title }}
                    </button>
                  </th>
                  <!-- Subtotali senza colori: in un secchio si sommano spese e risparmi. -->
                  <ng-container *ngTemplateOutlet="cells; context: { $implicit: g, kind: 'balance', selectable: false }" />
                </tr>
                @if (!collapsed().has(g.key)) {
                  @for (r of g.rows; track r.key) {
                    <tr>
                      <th scope="row">{{ r.label }}</th>
                      <ng-container *ngTemplateOutlet="cells; context: { $implicit: r, kind: r.kind, selectable: true }" />
                    </tr>
                  }
                }
              </tbody>
            }
            @if (p.unassigned.total.actual) {
              <tbody>
                <tr class="unassigned">
                  <th scope="row">Da assegnare</th>
                  <!-- Senza previsione: niente colori. -->
                  <ng-container *ngTemplateOutlet="cells; context: { $implicit: p.unassigned, kind: 'balance', selectable: true }" />
                </tr>
              </tbody>
            }
            <tbody class="totals">
              @for (t of p.totals; track t.key) {
                <tr>
                  <th scope="row">{{ t.label }}</th>
                  <ng-container *ngTemplateOutlet="cells; context: { $implicit: t, kind: t.kind, selectable: false }" />
                </tr>
              }
            </tbody>
          </table>
        } @else if (!loadError()) {
          <p class="note">Caricamento…</p>
        }
      </div>

      @if (selectedRow(); as s) {
        <aside class="panel" aria-label="Dettaglio">
          <header>
            <h2>{{ s.row.label }} · {{ label(months()[s.month]) }}</h2>
            <button type="button" class="nav" aria-label="Chiudi il dettaglio" (click)="selected.set(null)">×</button>
          </header>
          <dl>
            <dt>Previsto</dt>
            <dd>
              @if (s.row.editable) {
                <input
                  inputmode="decimal"
                  autocomplete="off"
                  aria-label="Previsto"
                  [disabled]="!online()"
                  [value]="input(s.cell, s.row.kind)"
                  [placeholder]="placeholder(s.cell, s.row.kind)"
                  (keydown.enter)="blur($event)"
                  (change)="setForecast(s.row, s.month, $event)"
                />
              } @else {
                {{ money(s.cell.forecast) }}
              }
            </dd>
            <dt>Effettivo</dt>
            <dd>{{ money(s.cell.actual) }}</dd>
            @if (s.row.editable && s.month <= currentIndex()) {
              <dt>Differenza</dt>
              <dd [class]="tone(s.row.kind, s.cell)">{{ delta(s.row.kind, s.cell) }}</dd>
            }
          </dl>
          @if (s.row.editable && s.cell.forecast !== null && !s.cell.isDefault) {
            <form class="copy" (ngSubmit)="copyLine(s.row, s.month)">
              <label>
                Copia questa previsione fino a
                <select name="until" [(ngModel)]="copyUntil">
                  <option value="">Scegli il mese</option>
                  @for (m of after(s.month); track m) {
                    <option [value]="m">{{ label(m) }}</option>
                  }
                </select>
              </label>
              <button mat-stroked-button type="submit" [disabled]="!copyUntil || !online()">Copia</button>
            </form>
          }
          <h3>Movimenti</h3>
          <ul>
            @for (t of movements(); track t.id) {
              <li>
                <button type="button" (click)="launcher.open(t)">
                  <span>{{ day(t.booking_date) }} · {{ title(t) }}</span>
                  <span class="num">{{ fmt(t.amount_cents) }}</span>
                </button>
              </li>
            } @empty {
              <p class="note">Nessuno.</p>
            }
          </ul>
        </aside>
      }
    </div>

    <!-- Celle di una riga: 12 mesi più l'anno. -->
    <ng-template #cells let-row let-kind="kind" let-selectable="selectable">
      @for (c of row.cells; track $index; let i = $index) {
        @if (detailed()) {
          <td class="num" [class.cur]="i === currentIndex()">
            @if (row.editable) {
              <input
                class="cell-input"
                inputmode="decimal"
                autocomplete="off"
                [attr.aria-label]="'Previsto ' + row.label + ', ' + label(months()[i])"
                [disabled]="!online()"
                [value]="input(c, kind)"
                [placeholder]="placeholder(c, kind)"
                (keydown.enter)="blur($event)"
                (change)="setForecast(row, i, $event)"
              />
            } @else if (!blank(c)) {
              {{ amount(c.forecast) }}
            }
          </td>
          <td class="num" [class.cur]="i === currentIndex()">
            @if (i > currentIndex()) {
            } @else if (selectable) {
              <button type="button" class="cell" [attr.aria-label]="row.label + ', ' + label(months()[i]) + ': dettaglio'" (click)="select(row.key, i)">
                {{ blank(c) ? '' : amount(c.actual) }}
              </button>
            } @else if (!blank(c)) {
              {{ amount(c.actual) }}
            }
          </td>
          <td class="num delta" [class]="i <= currentIndex() ? tone(kind, c) : ''">{{ i <= currentIndex() ? delta(kind, c) : '' }}</td>
        } @else {
          <td class="num" [class.cur]="i === currentIndex()" [class.future]="i > currentIndex()" [class]="i <= currentIndex() ? tone(kind, c) : ''">
            @if (selectable) {
              <button type="button" class="cell" [attr.aria-label]="row.label + ', ' + label(months()[i]) + ': ' + compact(kind, c, i) + ', dettaglio'" (click)="select(row.key, i)">
                {{ compact(kind, c, i) }}
              </button>
            } @else {
              {{ compact(kind, c, i) }}
            }
          </td>
        }
      }
      @if (blank(row.total)) {
        <td class="num year" [attr.colspan]="detailed() ? 3 : 1"></td>
      } @else if (detailed()) {
        <td class="num year">{{ amount(row.total.forecast) }}</td>
        <td class="num year">{{ amount(row.total.actual) }}</td>
        <td class="num year delta"></td>
      } @else {
        <td class="num year">{{ amount(yearIsFuture() ? row.total.forecast : row.total.actual) }}</td>
      }
    </ng-template>
  `,
  styles: `
    :host {
      --better: light-dark(#15803d, #4ade80);
      display: grid;
      gap: 8px;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-title-large);
    }
    .nav {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 50%;
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-title-large);
      cursor: pointer;
    }
    .nav svg {
      width: 28px;
      height: 28px;
      fill: currentColor;
    }
    .segmented {
      display: flex;
      gap: 4px;
      margin-left: auto;
    }
    .segmented button {
      min-height: 44px;
      padding: 0 14px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 22px;
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }
    .segmented .on {
      border-color: var(--mat-sys-primary);
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    .layout {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .wrap {
      overflow: auto;
      max-height: calc(100dvh - 190px);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
    }
    table {
      border-collapse: separate;
      border-spacing: 0;
      font: var(--mat-sys-body-medium);
    }
    th,
    td {
      padding: 0 8px;
      height: 44px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      white-space: nowrap;
      background: var(--mat-sys-surface);
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      height: 36px;
      font: var(--mat-sys-label-large);
      color: var(--mat-sys-on-surface-variant);
    }
    thead tr.sub th {
      top: 36px;
      height: 28px;
      font: var(--mat-sys-label-small);
    }
    th[scope='row'],
    th[scope='rowgroup'],
    .corner {
      position: sticky;
      left: 0;
      z-index: 1;
      text-align: left;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .corner {
      z-index: 3;
    }
    th[scope='row'] {
      font: var(--mat-sys-body-medium);
      padding-left: 20px;
    }
    .group th,
    .group td {
      background: var(--mat-sys-surface-container);
      font-weight: 600;
    }
    .toggle {
      min-height: 44px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .totals th,
    .totals td {
      background: var(--mat-sys-surface-container-low);
      font-weight: 600;
    }
    .unassigned th {
      color: var(--mat-sys-tertiary);
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .cur {
      box-shadow: inset 0 0 0 9999px color-mix(in srgb, var(--mat-sys-primary) 6%, transparent);
    }
    .year {
      font-weight: 600;
    }
    .future {
      font-style: italic;
      color: var(--mat-sys-on-surface-variant);
    }
    .cell {
      width: 100%;
      min-height: 44px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: right;
      cursor: pointer;
    }
    .cell-input {
      width: 7em;
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: none;
      color: inherit;
      font: inherit;
      text-align: right;
    }
    .cell-input:hover,
    .cell-input:focus {
      border-color: var(--mat-sys-outline);
      background: var(--mat-sys-surface);
    }
    .better {
      color: var(--better);
    }
    .much-better {
      color: var(--better);
      font-weight: 600;
      box-shadow: inset 0 0 0 9999px color-mix(in srgb, var(--better) 14%, transparent);
    }
    .worse {
      color: var(--mat-sys-error);
    }
    .much-worse {
      color: var(--mat-sys-error);
      font-weight: 600;
      box-shadow: inset 0 0 0 9999px color-mix(in srgb, var(--mat-sys-error) 14%, transparent);
    }
    .panel {
      display: grid;
      align-content: start;
      gap: 12px;
      padding: 12px 16px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
      overflow: auto;
    }
    .panel header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel h2,
    .panel h3 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px 16px;
      align-items: center;
      margin: 0;
    }
    dd {
      margin: 0;
      text-align: right;
    }
    .panel input,
    .panel select {
      min-height: 44px;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
      text-align: right;
    }
    .copy,
    .copy label {
      display: grid;
      gap: 6px;
    }
    .copy button {
      justify-self: end;
      min-height: 44px;
    }
    .panel ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .panel li button {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
      min-height: 44px;
      border: 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    /* Pannello fisso accanto alla griglia sui PC; sopra la griglia, a destra, altrove. */
    @media (min-width: 1440px) {
      .layout.with-panel {
        grid-template-columns: minmax(0, 1fr) 360px;
      }
    }
    @media (max-width: 1439px) {
      .panel {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 20;
        width: min(380px, 100%);
        box-sizing: border-box;
        padding-top: calc(12px + env(safe-area-inset-top));
        border-radius: 0;
        box-shadow: var(--mat-sys-level3);
      }
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .note {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class Year {
  protected readonly ledger = inject(Ledger);
  protected readonly launcher = inject(QuickAddLauncher);
  private readonly snackBar = inject(MatSnackBar);
  private readonly sync = inject(Sync);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly label = monthLabel;
  protected readonly densities: Density[] = ['compatta', 'dettagliata'];
  /** 12 mesi più la colonna dell'anno, per la seconda riga d'intestazione. */
  protected readonly columns = Array.from({ length: 13 });
  protected readonly current = currentMonth();

  protected readonly year = signal(Number(this.current.slice(0, 4)));
  protected readonly density = signal<Density>(readDensity());
  protected readonly detailed = computed(() => this.density() === 'dettagliata');
  protected readonly collapsed = signal(new Set<string>());
  protected readonly selected = signal<{ key: string; month: number } | null>(null);
  protected readonly movements = signal<Transaction[]>([]);
  protected readonly loadError = signal('');
  protected copyUntil = '';
  private readonly loaded = signal<{ year: number; months: MonthOverview[] } | null>(null);

  protected readonly months = computed(() => Array.from({ length: 12 }, (_, i) => `${this.year()}-${String(i + 1).padStart(2, '0')}-01`));
  /** Indice del mese corrente nell'anno mostrato: -1 se l'anno è futuro, 12 se è passato. */
  protected readonly currentIndex = computed(() => {
    const y = Number(this.current.slice(0, 4));
    return this.year() < y ? 12 : this.year() > y ? -1 : Number(this.current.slice(5, 7)) - 1;
  });
  protected readonly yearIsFuture = computed(() => this.currentIndex() < 0);

  protected readonly pivot = computed(() => {
    const loaded = this.loaded();
    return loaded?.year === this.year() ? pivotYear(loaded.months, this.ledger.categoryById(), this.ledger.buckets()) : null;
  });

  protected readonly selectedRow = computed(() => {
    const sel = this.selected();
    const p = this.pivot();
    if (!sel || !p) return null;
    const row = [...p.groups.flatMap((g) => g.rows), p.unassigned].find((r) => r.key === sel.key);
    return row ? { row, month: sel.month, cell: row.cells[sel.month] } : null;
  });

  constructor() {
    effect(() => {
      const year = this.year();
      this.sync.synced();
      untracked(() => void this.load(year));
    });
    // I movimenti del pannello seguono la cella scelta e i dati ricaricati.
    effect(() => {
      const s = this.selectedRow();
      untracked(() => void this.loadMovements(s?.row ?? null, s?.month ?? 0));
    });
  }

  protected setDensity(d: Density): void {
    this.density.set(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      // la scelta vale solo per questa visita
    }
  }

  protected toggle(key: string): void {
    const next = new Set(this.collapsed());
    if (!next.delete(key)) next.add(key);
    this.collapsed.set(next);
  }

  protected select(key: string, month: number): void {
    this.copyUntil = '';
    this.selected.set({ key, month });
  }

  protected short(month: string): string {
    return new Date(month + 'T12:00:00').toLocaleDateString('it-IT', { month: 'short' });
  }

  protected day(date: string): string {
    return new Date(date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  }

  protected title(t: Transaction): string {
    return movementTitle(t, this.ledger);
  }

  protected after(month: number): string[] {
    return Array.from({ length: 24 }, (_, i) => shiftMonth(this.months()[month], i + 1));
  }

  protected amount(cents: number | null): string {
    // "|| 0" evita il "-0,00" dei negativi di zero.
    return cents === null ? '' : number.format(cents / 100 || 0);
  }

  /** Cella senza previsione né movimenti: vuota invece di "0,00", per non fare rumore. */
  protected blank(c: Cell): boolean {
    return !c.forecast && !c.actual;
  }

  protected money(cents: number | null): string {
    return cents === null ? '—' : formatCents(cents);
  }

  protected input(c: Cell, kind: string): string {
    return forecastToInput(c.forecast, kind, c.isDefault);
  }

  protected placeholder(c: Cell, kind: string): string {
    return c.isDefault && c.forecast !== null ? signedText(c.forecast, kind) : '';
  }

  /** Colore dello scostamento; senza previsione né movimenti, niente colore. */
  protected tone(kind: string, c: Cell): string {
    if (kind === 'balance' || c.actual === null || this.blank(c)) return '';
    return deviation(kind, c.forecast ?? 0, c.actual);
  }

  /** Differenza con il segno di "meglio" (+) o "peggio" (−) e la freccia. */
  protected delta(kind: string, c: Cell): string {
    if (kind === 'balance' || c.actual === null || this.blank(c)) return '';
    const better = (c.actual - (c.forecast ?? 0)) * (kind === 'saving' ? -1 : 1);
    if (!better) return '=';
    return `${better > 0 ? '+' : '−'}${number.format(Math.abs(better) / 100)} ${better > 0 ? '↑' : '↓'}`;
  }

  /** Vista compatta: effettivo nei mesi passati (con la freccia se lontano dal previsto), previsto in quelli futuri. */
  protected compact(kind: string, c: Cell, month: number): string {
    if (month > this.currentIndex()) return this.amount(c.forecast);
    if (this.blank(c)) return '';
    const level = this.tone(kind, c);
    const arrow = level.includes('better') ? ' ↑' : level.includes('worse') ? ' ↓' : '';
    return this.amount(c.actual) + arrow;
  }

  protected blur(e: Event): void {
    (e.target as HTMLInputElement).blur();
  }

  protected async setForecast(row: GridRow, month: number, e: Event): Promise<void> {
    const amount = inputToForecast((e.target as HTMLInputElement).value, row.kind);
    if (amount === undefined) {
      this.snackBar.open('Importo non valido', 'OK', { duration: 4000 });
      return;
    }
    this.done(await writeForecast(this.months()[month], row.categoryId!, row.bucketId, amount), 'Previsione non salvata');
  }

  protected async copyLine(row: GridRow, month: number): Promise<void> {
    const forecast = row.cells[month].forecast;
    if (!this.copyUntil || forecast === null) return;
    const until = this.copyUntil;
    const res = await copyForecast(this.months()[month], until, [{ category_id: row.categoryId!, bucket_id: row.bucketId, forecast }]);
    if (res !== 'cancelled' && this.done(res, 'Copia non riuscita')) {
      this.copyUntil = '';
      this.snackBar.open(`Previsione copiata fino a ${monthLabel(until)}`, 'OK', { duration: 4000 });
    }
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): boolean {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load(this.year());
    void this.ledger.load();
    return !res.error;
  }

  private async load(year: number): Promise<void> {
    // In GET: il service worker la conserva per la lettura offline.
    const res = await supabase.rpc('year_grid', { p_year: year }, { get: true });
    if (year !== this.year()) return;
    this.loadError.set(res.error ? 'Dati non aggiornati: ' + errorText(res) : '');
    if (res.data) this.loaded.set({ year, months: res.data as unknown as MonthOverview[] });
  }

  /** Movimenti della cella: stessa categoria e secchio, oppure quelli da assegnare. */
  private async loadMovements(row: GridRow | null, month: number): Promise<void> {
    if (!row) {
      this.movements.set([]);
      return;
    }
    const res = await supabase
      .from('transactions')
      .select('*, transaction_tags(tag_id)')
      .eq('month', this.months()[month])
      .neq('status', 'declined')
      .order('booking_date');
    const cats = this.ledger.categoryById();
    this.movements.set(
      (res.data ?? []).filter((t) => {
        if (row.categoryId) return t.category_id === row.categoryId && t.bucket_id === row.bucketId;
        const cat = cats.get(t.category_id ?? '');
        // Come la riga "Da assegnare" della vista mese: i trasferimenti ordinari non contano.
        return !(t.transfer_group_id && !t.category_id) && (!cat || (cat.kind !== 'income' && !t.bucket_id));
      }),
    );
  }
}
