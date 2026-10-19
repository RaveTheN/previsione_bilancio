import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { currentMonth, Ledger, monthLabel, shiftMonth } from '../../core/ledger';
import { centsToInput, diffTone, formatCents, parseSignedAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { Category, errorText, MonthLine, supabase } from '../../core/supabase';
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
  rows: Row[];
  forecast: number;
  actual: number;
}

const ON_CONFLICT = 'user_id,month,category_id,bucket_id';
const percent = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 1 });
const TONE_WORD = { better: 'meglio', worse: 'peggio', even: 'in linea' };

/** Nella previsione si scrivono importi positivi: il segno lo decide il tipo di categoria. */
function sign(kind: string): number {
  return kind === 'income' ? 1 : -1;
}

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
              <td>{{ fmt(-o.saving_forecast) }}</td>
              @if (!future()) {
                <td>{{ fmt(-o.saving_actual) }}</td>
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

      @if (bucketStats().length) {
        <section class="card" aria-label="Secchi sullo stipendio">
          @for (b of bucketStats(); track b.bucket_id) {
            <div class="bucket">
              <div class="line">
                <span>{{ b.name }}</span>
                <span>{{ pct(future() ? b.forecast_pct : b.actual_pct) }}</span>
              </div>
              <div class="bar" aria-hidden="true">
                <span [style.width.%]="clamp(future() ? b.forecast_pct : b.actual_pct)"></span>
                <i [style.left.%]="clamp(b.target_pct)"></i>
              </div>
              <span class="sub">
                Obiettivo {{ pct(b.target_pct) }} · previsto {{ pct(b.forecast_pct) }}{{ future() ? '' : ' · reale ' + pct(b.actual_pct) }}
              </span>
            </div>
          }
        </section>
      }

      @if (unassigned().n) {
        <a class="unassigned" routerLink="/movimenti" [queryParams]="{ filtro: 'da-assegnare' }">
          <span>Da assegnare · {{ unassigned().n }} movimenti</span>
          <strong>{{ fmt(unassigned().cents) }}</strong>
        </a>
      }

      <div class="actions">
        <button mat-stroked-button type="button" [attr.aria-pressed]="editing()" (click)="editing.set(!editing())">
          {{ editing() ? 'Fine' : 'Modifica previsione' }}
        </button>
        <button mat-stroked-button type="button" (click)="launcher.openTransfer()">Trasferisci</button>
      </div>

      @if (editing() && !online()) {
        <p class="warn" role="status">Sei offline: la previsione si modifica solo con la connessione.</p>
      }

      <fieldset [disabled]="editing() && (!online() || busy())">
        @for (g of groups(); track g.title) {
          <section>
            <h2>
              <span>{{ g.title }}</span><span>{{ fmt(future() || editing() ? g.forecast : g.actual) }}</span>
            </h2>
            <ul>
              @for (r of g.rows; track r.category_id + '/' + r.bucket_id) {
                <li>
                  <div class="line">
                    <span>{{ r.cat!.name }}</span>
                    @if (editing()) {
                      <input
                        inputmode="decimal"
                        autocomplete="off"
                        [attr.aria-label]="'Previsione ' + r.cat!.name + ' · ' + g.title"
                        [value]="forecastText(r)"
                        [placeholder]="placeholder(r)"
                        (change)="setForecast(r, $event)"
                      />
                    } @else {
                      <span>{{ future() ? fmtN(r.forecast) : fmt(r.actual) }}</span>
                    }
                  </div>
                  @if (editing()) {
                    @if (r.is_default) {
                      <span class="sub">{{ defaultText(r) }}</span>
                    }
                  } @else if (!future()) {
                    <div class="bar" aria-hidden="true">
                      <span [class]="tone(r)" [style.width.%]="fill(r)"></span>
                    </div>
                    <span class="sub">
                      Previsto {{ fmtN(r.forecast) }} ·
                      <span [class]="tone(r)">{{ tone(r) === 'better' ? '↑' : tone(r) === 'worse' ? '↓' : '=' }} {{ diffText(r) }}</span>
                    </span>
                  }
                </li>
              }
            </ul>
          </section>
        } @empty {
          @if (!unassigned().n && !editing()) {
            <p class="note">Nessun movimento né previsione in questo mese.</p>
          }
        }

        @if (editing()) {
          <form class="tool" (ngSubmit)="addLine()">
            <h2>Aggiungi una riga</h2>
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

          <form class="tool" (ngSubmit)="copy()">
            <h2>Copia nei mesi successivi</h2>
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
        }
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
    .label,
    .sub {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      min-height: 40px;
    }
    .bucket {
      display: grid;
      gap: 4px;
    }
    .bar {
      position: relative;
      height: 6px;
      border-radius: 3px;
      background: var(--mat-sys-surface-container-highest);
    }
    .bar span {
      display: block;
      height: 100%;
      max-width: 100%;
      border-radius: 3px;
      background: var(--mat-sys-primary);
    }
    .bar i {
      position: absolute;
      top: -3px;
      width: 2px;
      height: 12px;
      background: var(--mat-sys-on-surface);
    }
    .bar .worse {
      background: var(--mat-sys-error);
    }
    .bar .better {
      background: var(--better);
    }
    .sub .worse {
      color: var(--mat-sys-error);
    }
    .sub .better {
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
    .actions button {
      min-height: 44px;
    }
    h2 {
      display: flex;
      justify-content: space-between;
      margin: 0 0 4px;
      font: var(--mat-sys-title-small);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: grid;
      gap: 4px;
      padding: 6px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
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
    .line input {
      width: 8em;
      text-align: right;
    }
    .tool {
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
  protected readonly editing = signal(false);
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
    const group = (title: string, keep: (r: Row) => boolean): Group => {
      const rows = this.rows()
        .filter((r) => !r.unassigned && keep(r))
        .sort((a, b) => a.cat!.sort_order - b.cat!.sort_order || a.cat!.name.localeCompare(b.cat!.name));
      const forecast = rows.reduce((s, r) => s + (r.forecast ?? 0), 0);
      return { title, rows, forecast, actual: rows.reduce((s, r) => s + r.actual, 0) };
    };
    const buckets = this.ledger.buckets().map((b) => group(b.name, (r) => r.kind !== 'income' && r.bucket_id === b.id));
    return [group('Entrate', (r) => r.kind === 'income'), ...buckets].filter((g) => g.rows.length);
  });

  protected readonly bucketStats = computed(() => {
    const names = this.ledger.bucketById();
    return (this.ov()?.buckets ?? []).map((b) => ({ ...b, name: names.get(b.bucket_id)?.name ?? '' }));
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

  protected clamp(value: number | null): number {
    return Math.min(100, Math.max(0, value ?? 0));
  }

  protected tone(r: Row): 'better' | 'worse' | 'even' {
    return diffTone(r.kind, r.forecast ?? 0, r.actual);
  }

  protected diffText(r: Row): string {
    return `${formatCents(Math.abs(r.actual - (r.forecast ?? 0)))} ${TONE_WORD[this.tone(r)]}`;
  }

  /** Quanto dell'importo previsto è già stato raggiunto. */
  protected fill(r: Row): number {
    if (!r.forecast) return r.actual ? 100 : 0;
    return this.clamp((100 * Math.abs(r.actual)) / Math.abs(r.forecast));
  }

  /** Spiega il risparmio predefinito: importo fisso (con la % che fa sullo stipendio) o percentuale. */
  protected defaultText(r: Row): string {
    const s = this.ledger.settings();
    if (s?.savings_amount_cents == null) return `Predefinita: ${this.pct(s?.savings_pct ?? null)} dello stipendio previsto`;
    const salary = this.rows()
      .filter((x) => x.cat?.is_salary)
      .reduce((sum, x) => sum + (x.forecast ?? 0), 0);
    const share = salary > 0 ? `, ${this.pct((-100 * (r.forecast ?? 0)) / salary)} dello stipendio previsto` : '';
    return `Predefinita: importo fisso${share}`;
  }

  protected forecastText(r: Row): string {
    return r.forecast === null || r.is_default ? '' : centsToInput(r.forecast * sign(r.kind));
  }

  protected placeholder(r: Row): string {
    return r.is_default && r.forecast !== null ? centsToInput(r.forecast * sign(r.kind)) : 'nessuna';
  }

  /** Campo vuoto = nessuna previsione; per il risparmio torna quella predefinita. */
  protected async setForecast(r: Row, e: Event): Promise<void> {
    const text = (e.target as HTMLInputElement).value.trim();
    const cents = text ? parseSignedAmount(text) : null;
    if (text && cents === null) {
      this.snackBar.open('Importo non valido', 'OK', { duration: 4000 });
      return;
    }
    await this.write(r.category_id!, r.bucket_id, cents === null ? null : cents * sign(r.kind));
  }

  protected async addLine(): Promise<void> {
    const cat = this.ledger.categoryById().get(this.newCategory());
    const cents = parseSignedAmount(this.newAmount);
    if (!cat || cents === null || (cat.kind !== 'income' && !this.newBucket)) {
      this.snackBar.open('Scegli categoria, secchio e un importo valido', 'OK', { duration: 4000 });
      return;
    }
    if (await this.write(cat.id, cat.kind === 'income' ? null : this.newBucket, cents * sign(cat.kind))) {
      this.newAmount = '';
    }
  }

  /** Copia le righe scritte di questo mese nei mesi successivi: sostituisce le stesse righe, lascia le altre. */
  protected async copy(): Promise<void> {
    const from = this.ledger.month();
    const until = this.copyUntil;
    const lines = this.rows().filter((r) => r.forecast !== null && !r.is_default && r.category_id);
    if (!until || until <= from) return;
    if (!lines.length) {
      this.snackBar.open('Questo mese non ha previsioni da copiare', 'OK', { duration: 4000 });
      return;
    }
    this.busy.set(true);
    try {
      const existing = await supabase
        .from('budget_lines')
        .select('id', { count: 'exact', head: true })
        .gt('month', from)
        .lte('month', until);
      if (existing.error) {
        this.done(existing, 'Copia non riuscita');
        return;
      }
      const range = `${monthLabel(shiftMonth(from, 1))} – ${monthLabel(until)}`;
      if (
        existing.count &&
        !confirm(`In ${range} ci sono già ${existing.count} righe di previsione: quelle con la stessa categoria e lo stesso secchio verranno sostituite. Continuare?`)
      ) {
        return;
      }
      const months = this.nextMonths().filter((m) => m <= until);
      const rows = months.flatMap((month) =>
        lines.map((l) => ({ month, category_id: l.category_id!, bucket_id: l.bucket_id, amount_cents: l.forecast! })),
      );
      if (this.done(await supabase.from('budget_lines').upsert(rows, { onConflict: ON_CONFLICT }), 'Copia non riuscita')) {
        this.copyUntil = '';
        this.snackBar.open(`Previsione copiata in ${range}`, 'OK', { duration: 4000 });
      }
    } finally {
      this.busy.set(false);
    }
  }

  private async write(categoryId: string, bucketId: string | null, amount: number | null): Promise<boolean> {
    const month = this.ledger.month();
    if (amount !== null) {
      const row = { month, category_id: categoryId, bucket_id: bucketId, amount_cents: amount };
      return this.done(await supabase.from('budget_lines').upsert(row, { onConflict: ON_CONFLICT }), 'Previsione non salvata');
    }
    const q = supabase.from('budget_lines').delete().eq('month', month).eq('category_id', categoryId);
    return this.done(await (bucketId ? q.eq('bucket_id', bucketId) : q.is('bucket_id', null)), 'Previsione non eliminata');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): boolean {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.ledger.load();
    return !res.error;
  }
}
