import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { currentMonth, Ledger, monthLabel, shiftMonth } from '../../core/ledger';
import { copyForecast, forecastToInput, inputToForecast, signedText, writeForecast } from '../../core/budget';
import { diffTone, formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { Category, errorText, MonthLine, MonthOverview } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { MonthHeader, SwipeMonth } from '../../shared/month-header';
import { QuickAddLauncher } from '../quick-add/quick-add';

interface Row extends MonthLine {
  cat: Category | undefined;
  kind: string;
  unassigned: boolean;
}

interface Group {
  title: string;
  /** Percentuali del secchio sullo stipendio; assente per le entrate. */
  stat: MonthOverview['buckets'][number] | undefined;
  rows: Row[];
  forecast: number;
  actual: number;
}

const percent = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 1 });

@Component({
  selector: 'app-month',
  imports: [FormsModule, MatButtonModule, MonthHeader, RouterLink],
  hostDirectives: [SwipeMonth],
  template: `
    <app-month-header />

    @if (ledger.loadError()) {
      <p class="warn" role="status">{{ ledger.loadError() }}</p>
    }
    @if (sync.ops().length) {
      <p class="note" role="status">{{ sync.ops().length }} modifiche in attesa: i totali le includeranno dopo l'invio.</p>
    }

    @if (ov(); as o) {
      <section class="card" aria-label="Riepilogo del mese">
        <table>
          <thead>
            <tr>
              <td></td>
              <th scope="col">Previsto</th>
              @if (!future()) {
                <th scope="col">Effettivo</th>
              }
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Residuo iniziale</th>
              <td>{{ fmtN(o.start_forecast) }}</td>
              @if (!future()) {
                <td>{{ fmtN(o.start_actual) }}</td>
              }
            </tr>
            <tr>
              <th scope="row">Entrate</th>
              <td>{{ fmt(o.income_forecast) }}</td>
              @if (!future()) {
                <td>{{ fmt(o.income_actual) }}</td>
              }
            </tr>
            <tr>
              <th scope="row">Uscite</th>
              <td>{{ fmt(o.expense_forecast) }}</td>
              @if (!future()) {
                <td>{{ fmt(o.expense_actual) }}</td>
              }
            </tr>
            <tr>
              <th scope="row">Accantonato</th>
              <!-- || 0: il meno di zero stamperebbe "-0,00 €". -->
              <td>{{ fmt(-o.saving_forecast || 0) }}</td>
              @if (!future()) {
                <td>{{ fmt(-o.saving_actual || 0) }}</td>
              }
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Disponibile a fine mese</th>
              <td>{{ fmtN(o.end_forecast) }}</td>
              @if (!future()) {
                <td>{{ fmtN(o.end_actual) }}</td>
              }
            </tr>
          </tfoot>
        </table>
        @if (!ledger.settings()) {
          <p class="note">
            Per il disponibile imposta mese di avvio e residuo di apertura in <a routerLink="/altro">Altro</a>.
          </p>
        } @else if (o.start_forecast === null) {
          <p class="note">Mese precedente all'avvio del bilancio: il residuo qui non si calcola.</p>
        }
      </section>

      @if (o.reserve_actual !== null) {
        <section class="card reserve" aria-label="Salvadanaio">
          <span class="label">{{ future() ? 'Salvadanaio previsto a fine mese' : 'Salvadanaio a fine mese' }}</span>
          <strong>{{ fmtN(future() ? o.reserve_forecast : o.reserve_actual) }}</strong>
          <span class="label">Totale con il disponibile: {{ fmtN(total()) }}</span>
        </section>
      }

      @if (o.debt_cents) {
        <a class="card debt" routerLink="/debiti">
          <span class="label">Rate del mese</span>
          <strong>{{ fmt(o.debt_cents) }}{{ o.debt_pct === null ? '' : ' · ' + pct(o.debt_pct) + ' dello stipendio' }}</strong>
        </a>
      }

      @if (unassigned().n) {
        <a class="unassigned" routerLink="/movimenti" [queryParams]="{ filtro: 'da-assegnare' }">
          <span>Da assegnare · {{ unassigned().n }} movimenti</span>
          <strong>{{ fmt(unassigned().cents) }}</strong>
        </a>
      }

      <div class="actions">
        <button mat-stroked-button type="button" (click)="launcher.openTransfer()">Trasferisci</button>
        <a mat-stroked-button routerLink="/grafici">Grafici</a>
      </div>

      @if (!online()) {
        <p class="warn" role="status">Sei offline: la previsione si modifica solo con la connessione.</p>
      }

      <fieldset [disabled]="!online() || busy()">
        @if (groups().length) {
          <table class="grid">
            <thead>
              <tr>
                <td></td>
                <th scope="col">Previsto</th>
                @if (!future()) {
                  <th scope="col">Effettivo</th>
                }
              </tr>
            </thead>
            @for (g of groups(); track g.title) {
              <tbody>
                <tr class="group">
                  <th scope="rowgroup">
                    {{ g.title }}
                    @if (g.stat) {
                      <span class="sub">obiettivo {{ pct(g.stat.target_pct) }}</span>
                    }
                  </th>
                  <td>
                    {{ fmt(g.forecast) }}
                    @if (g.stat) {
                      <span class="sub">{{ pct(g.stat.forecast_pct) }}</span>
                    }
                  </td>
                  @if (!future()) {
                    <td>
                      {{ fmt(g.actual) }}
                      @if (g.stat) {
                        <span class="sub">{{ pct(g.stat.actual_pct) }}</span>
                      }
                    </td>
                  }
                </tr>
                @for (r of g.rows; track r.category_id + '/' + r.bucket_id) {
                  <tr>
                    <th scope="row">
                      {{ r.cat!.name }}
                      @if (r.is_default) {
                        <span class="sub">{{ defaultText(r) }}</span>
                      }
                    </th>
                    <td>
                      <input
                        inputmode="decimal"
                        autocomplete="off"
                        [attr.aria-label]="'Previsione ' + r.cat!.name + ' · ' + g.title"
                        [value]="forecastText(r)"
                        [placeholder]="placeholder(r)"
                        (change)="setForecast(r, $event)"
                      />
                    </td>
                    @if (!future()) {
                      <!-- Mai solo il colore: la freccia dice se è meglio o peggio del previsto. -->
                      <td [class]="tone(r)">{{ fmt(r.actual) }}{{ arrow(r) }}</td>
                    }
                  </tr>
                }
              </tbody>
            }
          </table>
        } @else if (!unassigned().n) {
          <p class="note">Nessun movimento né previsione in questo mese: aggiungi una riga qui sotto.</p>
        }

        <details class="tool">
          <summary>Aggiungi una riga</summary>
          <form (ngSubmit)="addLine()">
            <select name="category" aria-label="Categoria" [ngModel]="newCategory()" (ngModelChange)="newCategory.set($event)">
              <option value="">Categoria</option>
              @for (c of activeCategories(); track c.id) {
                <option [value]="c.id">{{ c.name }}</option>
              }
            </select>
            @if (newKind() !== 'income') {
              <select name="bucket" aria-label="Secchio" [(ngModel)]="newBucket">
                <option value="">Secchio</option>
                @for (b of ledger.buckets(); track b.id) {
                  <option [value]="b.id">{{ b.name }}</option>
                }
              </select>
            }
            <input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" aria-label="Importo" [(ngModel)]="newAmount" />
            <button mat-stroked-button type="submit">Aggiungi</button>
          </form>
        </details>

        <details class="tool">
          <summary>Copia nei mesi successivi</summary>
          <form (ngSubmit)="copy()">
            <label>
              Fino a
              <select name="until" [(ngModel)]="copyUntil">
                <option value="">Scegli il mese</option>
                @for (m of nextMonths(); track m) {
                  <option [value]="m">{{ label(m) }}</option>
                }
              </select>
            </label>
            <button mat-stroked-button type="submit" [disabled]="!copyUntil">Copia</button>
          </form>
        </details>
      </fieldset>
    }
  `,
  styles: `
    :host {
      --better: light-dark(#15803d, #4ade80);
      display: grid;
      gap: 16px;
    }
    fieldset {
      display: grid;
      gap: 16px;
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    .card {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 4px 0;
      text-align: right;
      white-space: nowrap;
    }
    th[scope='row'] {
      text-align: left;
      font: var(--mat-sys-body-medium);
      white-space: normal;
    }
    thead th {
      font: var(--mat-sys-label-medium);
      color: var(--mat-sys-on-surface-variant);
    }
    tfoot th,
    tfoot td {
      padding-top: 8px;
      border-top: 1px solid var(--mat-sys-outline-variant);
      font: var(--mat-sys-title-small);
    }
    .reserve strong {
      font: var(--mat-sys-title-medium);
    }
    .debt {
      color: inherit;
      text-decoration: none;
    }
    .label,
    .sub {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    /* La tabella delle voci, come nel foglio: voce, previsto (si scrive nella cella), effettivo. */
    .grid th,
    .grid td {
      padding: 2px 0 2px 8px;
      vertical-align: middle;
    }
    .grid th[scope='row'],
    .grid th[scope='rowgroup'] {
      padding-left: 0;
      text-align: left;
      white-space: normal;
    }
    .grid tr:not(.group) {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .grid .group > * {
      padding-top: 16px;
      vertical-align: bottom;
      font: var(--mat-sys-title-small);
    }
    .grid .sub {
      display: block;
      font-weight: normal;
    }
    .grid input {
      box-sizing: border-box;
      width: 6.5em;
      min-height: 40px;
      border-color: transparent;
      background: var(--mat-sys-surface-container-high);
      font: var(--mat-sys-body-medium);
      text-align: right;
    }
    .grid input:focus {
      border-color: var(--mat-sys-primary);
    }
    .grid input::placeholder {
      color: var(--mat-sys-on-surface-variant);
      font-style: italic;
    }
    .grid .worse {
      color: var(--mat-sys-error);
    }
    .grid .better {
      color: var(--better);
    }
    .unassigned {
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-height: 48px;
      padding: 0 12px;
      border-radius: 12px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
      text-decoration: none;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .actions button,
    .actions a {
      min-height: 44px;
    }
    input,
    select {
      min-height: 44px;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    .tool summary {
      display: flex;
      align-items: center;
      min-height: 44px;
      font: var(--mat-sys-title-small);
      cursor: pointer;
    }
    .tool form {
      display: grid;
      gap: 8px;
    }
    .tool label {
      display: grid;
      gap: 4px;
    }
    .tool button {
      justify-self: end;
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
export class Month {
  protected readonly ledger = inject(Ledger);
  protected readonly sync = inject(Sync);
  protected readonly launcher = inject(QuickAddLauncher);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly label = monthLabel;

  protected readonly ov = this.ledger.overview;
  /** Nei mesi futuri non c'è un effettivo da mostrare: solo la previsione. */
  protected readonly future = computed(() => this.ledger.month() > currentMonth());
  protected readonly busy = signal(false);
  protected readonly newCategory = signal('');
  protected newBucket = '';
  protected newAmount = '';
  protected copyUntil = '';

  private readonly rows = computed<Row[]>(() => {
    const cats = this.ledger.categoryById();
    return (this.ov()?.lines ?? []).map((l) => {
      const cat = l.category_id ? cats.get(l.category_id) : undefined;
      const kind = cat?.kind ?? (l.inflow ? 'income' : 'expense');
      return { ...l, cat, kind, unassigned: !cat || (kind !== 'income' && !l.bucket_id) };
    });
  });

  protected readonly unassigned = computed(() =>
    this.rows()
      .filter((r) => r.unassigned)
      .reduce((acc, r) => ({ n: acc.n + r.n, cents: acc.cents + r.actual }), { n: 0, cents: 0 }),
  );

  /** Entrate, poi un gruppo per secchio (uscite e risparmi), con le righe nell'ordine delle categorie. */
  protected readonly groups = computed<Group[]>(() => {
    const group = (title: string, bucketId: string | null, keep: (r: Row) => boolean): Group => {
      const rows = this.rows()
        .filter((r) => !r.unassigned && keep(r))
        .sort((a, b) => a.cat!.sort_order - b.cat!.sort_order || a.cat!.name.localeCompare(b.cat!.name));
      const forecast = rows.reduce((s, r) => s + (r.forecast ?? 0), 0);
      const stat = this.ov()?.buckets.find((s) => s.bucket_id === bucketId);
      return { title, stat, rows, forecast, actual: rows.reduce((s, r) => s + r.actual, 0) };
    };
    const buckets = this.ledger.buckets().map((b) => group(b.name, b.id, (r) => r.kind !== 'income' && r.bucket_id === b.id));
    return [group('Entrate', null, (r) => r.kind === 'income'), ...buckets].filter((g) => g.rows.length);
  });

  protected readonly total = computed(() => {
    const o = this.ov();
    const [reserve, end] = this.future() ? [o?.reserve_forecast, o?.end_forecast] : [o?.reserve_actual, o?.end_actual];
    return reserve == null || end == null ? null : reserve + end;
  });

  protected readonly activeCategories = computed(() => this.ledger.categories().filter((c) => !c.archived));
  protected readonly newKind = computed(() => this.ledger.categoryById().get(this.newCategory())?.kind);
  /** Fino a due anni avanti: abbastanza per pianificare anche l'anno dopo. */
  protected readonly nextMonths = computed(() => Array.from({ length: 24 }, (_, i) => shiftMonth(this.ledger.month(), i + 1)));

  protected fmtN(cents: number | null | undefined): string {
    return cents == null ? '—' : formatCents(cents);
  }

  protected pct(value: number | null): string {
    return value === null ? '—' : percent.format(value / 100);
  }

  protected tone(r: Row): 'better' | 'worse' | 'even' {
    return diffTone(r.kind, r.forecast ?? 0, r.actual);
  }

  protected arrow(r: Row): string {
    return { better: ' ↑', worse: ' ↓', even: '' }[this.tone(r)];
  }

  /** Spiega il risparmio predefinito: importo fisso (con la % che fa sullo stipendio) o percentuale. */
  protected defaultText(r: Row): string {
    if (r.cat?.is_interest) return 'Predefinita: saldo dei conti × tasso, meno il 26%';
    if (r.kind !== 'saving') return 'Predefinita: somma delle ricorrenti';
    const s = this.ledger.settings();
    if (s?.savings_amount_cents == null) return `Predefinita: ${this.pct(s?.savings_pct ?? null)} dello stipendio previsto`;
    const salary = this.rows()
      .filter((x) => x.cat?.is_salary)
      .reduce((sum, x) => sum + (x.forecast ?? 0), 0);
    const share = salary > 0 ? `, ${this.pct((-100 * (r.forecast ?? 0)) / salary)} dello stipendio previsto` : '';
    return `Predefinita: importo fisso${share}`;
  }

  protected forecastText(r: Row): string {
    return forecastToInput(r.forecast, r.kind, r.is_default);
  }

  protected placeholder(r: Row): string {
    return r.is_default && r.forecast !== null ? signedText(r.forecast, r.kind) : '—';
  }

  /** Campo vuoto = nessuna previsione; per il risparmio torna quella predefinita. */
  protected async setForecast(r: Row, e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const amount = inputToForecast(input.value, r.kind);
    if (amount === undefined) {
      this.snackBar.open('Importo non valido', 'OK', { duration: 4000 });
      input.value = this.forecastText(r);
      return;
    }
    await this.write(r.category_id!, r.bucket_id, amount);
  }

  protected async addLine(): Promise<void> {
    const cat = this.ledger.categoryById().get(this.newCategory());
    const amount = cat ? inputToForecast(this.newAmount, cat.kind) : undefined;
    if (!cat || amount == null || (cat.kind !== 'income' && !this.newBucket)) {
      this.snackBar.open('Scegli categoria, secchio e un importo valido', 'OK', { duration: 4000 });
      return;
    }
    if (await this.write(cat.id, cat.kind === 'income' ? null : this.newBucket, amount)) {
      this.newAmount = '';
    }
  }

  /** Copia le righe scritte di questo mese nei mesi successivi: sostituisce le stesse righe, lascia le altre. */
  protected async copy(): Promise<void> {
    const from = this.ledger.month();
    const until = this.copyUntil;
    const lines = this.rows()
      .filter((r) => r.forecast !== null && !r.is_default && r.category_id)
      .map((r) => ({ category_id: r.category_id!, bucket_id: r.bucket_id, forecast: r.forecast! }));
    if (!until || until <= from) return;
    if (!lines.length) {
      this.snackBar.open('Questo mese non ha previsioni da copiare', 'OK', { duration: 4000 });
      return;
    }
    this.busy.set(true);
    try {
      const res = await copyForecast(from, until, lines);
      if (res !== 'cancelled' && this.done(res, 'Copia non riuscita')) {
        this.copyUntil = '';
        this.snackBar.open(`Previsione copiata fino a ${monthLabel(until)}`, 'OK', { duration: 4000 });
      }
    } finally {
      this.busy.set(false);
    }
  }

  private async write(categoryId: string, bucketId: string | null, amount: number | null): Promise<boolean> {
    return this.done(await writeForecast(this.ledger.month(), categoryId, bucketId, amount), 'Previsione non salvata');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): boolean {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.ledger.load();
    return !res.error;
  }
}
