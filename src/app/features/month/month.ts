import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { currentMonth, Ledger, monthLabel, shiftMonth } from '../../core/ledger';
import { addLine, copyForecast, deleteLine, inputToForecast, lineKind, moveLine, RESERVE_LINES, ReserveLineType, signedText, updateLine } from '../../core/budget';
import { diffTone, formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, MonthLine, MonthOverview } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { MonthHeader, SwipeMonth } from '../../shared/month-header';
import { QuickAddLauncher } from '../quick-add/quick-add';

interface Row extends MonthLine {
  kind: string;
}

interface Group {
  title: string;
  /** null per le entrate: non hanno secchio. */
  bucketId: string | null;
  /** Percentuali del secchio sulle entrate; assente per le entrate stesse. */
  stat: MonthOverview['buckets'][number] | undefined;
  rows: Row[];
  forecast: number;
  actual: number;
}

/**
 * Somma le percentuali previste come le vede l'utente (già arrotondate a un decimale dal server):
 * si conta in decimi interi per non far scattare il rosso su un errore di virgola mobile.
 */
export function overPlanned(buckets: Pick<MonthOverview['buckets'][number], 'forecast_pct'>[]): boolean {
  return buckets.reduce((s, b) => s + Math.round((b.forecast_pct ?? 0) * 10), 0) > 1000;
}

const percent = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 1 });

@Component({
  selector: 'app-month',
  imports: [CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, FormsModule, MatButtonModule, MatMenuModule, MonthHeader, RouterLink],
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
          <span class="label">Salvadanaio previsto a fine mese</span>
          <strong>{{ fmtN(o.reserve_forecast) }}</strong>
          @if (!future()) {
            <span class="label">Saldo effettivo: {{ fmtN(o.reserve_actual) }}</span>
          }
          <span class="label">Totale con il disponibile: {{ fmtN(total()) }}</span>
        </section>
      }

      @if (o.debt_cents) {
        <a class="card debt" routerLink="/debiti">
          <span class="label">Rate del mese</span>
          <strong>{{ fmt(o.debt_cents) }}{{ o.debt_pct === null ? '' : ' · ' + pct(o.debt_pct) + ' delle entrate' }}</strong>
        </a>
      }

      @if (o.unassigned.n) {
        <a class="unassigned" routerLink="/movimenti" [queryParams]="{ filtro: 'da-assegnare' }">
          <span>Da assegnare · {{ o.unassigned.n }} movimenti</span>
          <strong>{{ fmt(o.unassigned.actual) }}</strong>
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
          <!-- Un riquadro per secchio: dove finisce il riquadro, finisce il secchio. -->
          <div class="buckets" cdkDropListGroup>
            @for (g of groups(); track g.title) {
              <table class="grid" [attr.aria-label]="g.title">
                <colgroup>
                  <col />
                  <col class="forecast" />
                  @if (!future()) {
                    <col class="actual" />
                  }
                </colgroup>
                <!-- Le righe si trascinano tra i secchi; le entrate non hanno secchio. -->
                <tbody
                  cdkDropList
                  [cdkDropListData]="g"
                  [cdkDropListDisabled]="!g.bucketId || !online()"
                  (cdkDropListDropped)="drop($event)"
                >
                  <tr class="group">
                    <th scope="rowgroup">
                      {{ g.title }}
                      @if (g.stat) {
                        <span class="sub">obiettivo {{ pct(g.stat.target_pct) }}</span>
                      }
                    </th>
                    <td>
                      <span class="sub">Previsto</span>
                      {{ fmt(g.forecast) }}
                      @if (g.stat) {
                        <span
                          class="sub"
                          [class.worse]="overPlanned()"
                          [attr.title]="overPlanned() ? 'I secchi insieme superano il 100% delle entrate previste' : null"
                          >{{ pct(g.stat.forecast_pct) }}</span
                        >
                      }
                    </td>
                    @if (!future()) {
                      <td>
                        <span class="sub">Effettivo</span>
                        {{ fmt(g.actual) }}
                        @if (g.stat) {
                          <span class="sub">{{ pct(g.stat.actual_pct) }}</span>
                        }
                      </td>
                    }
                  </tr>
                  @for (r of g.rows; track r.id) {
                    <tr cdkDrag cdkDragLockAxis="y" [cdkDragData]="r" [cdkDragDisabled]="!g.bucketId || !online()">
                      <th scope="row">
                        <div class="row-name">
                          @if (g.bucketId) {
                            <!-- Solo la maniglia trascina: il resto della riga si tocca e scorre normalmente. -->
                            <span class="handle" cdkDragHandle [attr.title]="'Trascina ' + r.name + ' in un altro secchio'">
                              <svg viewBox="0 -960 960 960" aria-hidden="true"><path [attr.d]="dragIcon" /></svg>
                            </span>
                          }
                          <button type="button" class="name" [matMenuTriggerFor]="rowMenu" [matMenuTriggerData]="{ r }">
                            {{ r.name }} <span aria-hidden="true">▾</span>
                          </button>
                        </div>
                      </th>
                      <td>
                        <input
                          inputmode="decimal"
                          autocomplete="off"
                          [attr.aria-label]="'Previsione ' + r.name + ' · ' + g.title"
                          [value]="forecastText(r)"
                          placeholder="—"
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
              </table>
            }
          </div>
          <mat-menu #rowMenu="matMenu">
            <ng-template matMenuContent let-r="r">
              <button mat-menu-item type="button" (click)="renameRow(r)">Rinomina</button>
              @if (r.kind !== 'income') {
                @for (b of ledger.buckets(); track b.id) {
                  @if (b.id !== r.bucket_id) {
                    <button mat-menu-item type="button" (click)="moveRow(r, b.id)">Sposta in {{ b.name }}</button>
                  }
                }
              }
              <button mat-menu-item type="button" (click)="deleteRow(r)">Elimina la riga</button>
            </ng-template>
          </mat-menu>
        } @else {
          <p class="note">Nessuna riga in questo mese: scrivi la lista qui sotto, come nel foglio.</p>
        }

        <details class="tool">
          <summary>Aggiungi una riga</summary>
          <form (ngSubmit)="addRow()">
            <select name="type" aria-label="Tipo di riga" [ngModel]="newType" (ngModelChange)="pickType($event)">
              <option value="">Riga normale</option>
              @for (t of reserveTypes; track t) {
                <option [value]="t">{{ reserveLines[t].name }}</option>
              }
            </select>
            @if (!newType) {
              <input name="name" autocomplete="off" placeholder="Nome (es. Affitto)" aria-label="Nome della riga" [(ngModel)]="newName" />
            }
            <!-- Il prelievo sta sempre tra le Entrate: niente secchio da scegliere. -->
            @if (newType !== 'withdrawal') {
              <select name="bucket" aria-label="Secchio" [(ngModel)]="newBucket">
                <option value="">Secchio</option>
                @for (b of ledger.buckets(); track b.id) {
                  <option [value]="b.id">{{ b.name }}</option>
                }
                @if (!newType) {
                  <option value="entrate">Entrate</option>
                }
              </select>
            }
            <input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" aria-label="Importo" [(ngModel)]="newAmount" />
            @if (newType) {
              <p class="note">{{ reserveLines[newType].note }}</p>
            } @else if (newBucket !== 'entrate') {
              <label class="check">
                <input type="checkbox" name="overGood" [(ngModel)]="newOverGood" />
                Superare il previsto è un bene (verde, come il risparmio)
              </label>
            }
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
    .buckets {
      display: grid;
      gap: 16px;
    }
    /* Colonne fisse: previsto ed effettivo restano in fila da un riquadro all'altro. */
    .grid {
      table-layout: fixed;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    .grid col.forecast {
      width: 96px;
    }
    .grid col.actual {
      width: 108px;
    }
    .row-name {
      display: flex;
      align-items: center;
    }
    .row-name .handle {
      flex: none;
    }
    .grid th,
    .grid td {
      padding: 2px 8px 2px 8px;
      vertical-align: middle;
    }
    .grid td:not(:last-child) {
      padding-right: 0;
    }
    .grid th[scope='row'],
    .grid th[scope='rowgroup'] {
      text-align: left;
      white-space: normal;
    }
    .grid tr:not(.group):not(:last-child) {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .grid .group:not(:last-child) {
      border-bottom: 2px solid var(--mat-sys-primary);
    }
    .grid .group > * {
      padding-top: 10px;
      padding-bottom: 8px;
      vertical-align: top;
      font: var(--mat-sys-title-small);
    }
    .grid .group th {
      font: var(--mat-sys-title-medium);
    }
    .handle {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 40px;
      vertical-align: middle;
      color: var(--mat-sys-on-surface-variant);
      cursor: grab;
    }
    .handle svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
    .grid tbody.cdk-drop-list-receiving {
      outline: 2px dashed var(--mat-sys-primary);
      outline-offset: -2px;
    }
    /* L'anteprima esce dalla tabella: le sue celle si mettono in fila da sole. */
    .cdk-drag-preview {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 12px;
      border-radius: 8px;
      background: var(--mat-sys-surface-container-highest);
      box-shadow: var(--mat-sys-level3);
    }
    .cdk-drag-placeholder {
      opacity: 0.3;
    }
    .cdk-drag-animating,
    .cdk-drop-list-dragging .cdk-drag:not(.cdk-drag-placeholder) {
      transition: transform 200ms cubic-bezier(0, 0, 0.2, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      .cdk-drag-animating,
      .cdk-drop-list-dragging .cdk-drag {
        transition: none;
      }
    }
    /* Il nome apre le azioni della riga, ma si legge come testo. */
    .grid .name {
      min-height: 40px;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .grid .name span {
      color: var(--mat-sys-on-surface-variant);
    }
    .grid .sub {
      display: block;
      font-weight: normal;
    }
    .grid input {
      box-sizing: border-box;
      width: 100%;
      min-height: 40px;
      border-color: transparent;
      background: var(--mat-sys-surface);
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
    .tool .check {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
    }
    .tool .check input {
      min-height: 0;
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
  protected newName = '';
  protected newBucket = '';
  protected newAmount = '';
  protected newOverGood = false;
  protected newType: ReserveLineType | '' = '';
  protected readonly reserveLines = RESERVE_LINES;
  protected readonly reserveTypes = Object.keys(RESERVE_LINES) as ReserveLineType[];
  protected copyUntil = '';

  /** Maniglia: sei puntini, due colonne per tre righe. */
  protected readonly dragIcon = [360, 600].flatMap((x) => [-720, -480, -240].map((y) => `M${x - 70} ${y}a70 70 0 1 0 140 0a70 70 0 1 0 -140 0Z`)).join('');
  /** Riga appena trascinata: si vede già nel nuovo secchio mentre si salva. */
  private readonly moving = signal<{ id: string; to: string } | null>(null);

  private readonly rows = computed<Row[]>(() => {
    const m = this.moving();
    const lines = this.ledger.lines();
    return (m ? moveLine(lines, m.id, m.to) : lines).map((l) => ({ ...l, kind: lineKind(l.bucket_id, l.over_is_good) }));
  });

  /** Entrate, poi un gruppo per secchio, con le righe nell'ordine scritto. */
  protected readonly groups = computed<Group[]>(() => {
    const group = (title: string, bucketId: string | null): Group => {
      const rows = this.rows().filter((r) => r.bucket_id === bucketId);
      const stat = this.ov()?.buckets.find((s) => s.bucket_id === bucketId);
      return { title, bucketId, stat, rows, forecast: rows.reduce((s, r) => s + r.forecast, 0), actual: rows.reduce((s, r) => s + r.actual, 0) };
    };
    const all = [group('Entrate', null), ...this.ledger.buckets().map((b) => group(b.name, b.id))];
    // I secchi restano anche vuoti, come nel foglio: servono per lasciarci una riga trascinata.
    return all.some((g) => g.rows.length) ? all.filter((g) => g.bucketId || g.rows.length) : [];
  });

  /** Il previsto di tutti i secchi supera le entrate previste: si segna in rosso in ogni secchio. */
  protected readonly overPlanned = computed(() => overPlanned(this.ov()?.buckets ?? []));

  protected readonly total = computed(() => {
    const o = this.ov();
    const [reserve, end] = this.future() ? [o?.reserve_forecast, o?.end_forecast] : [o?.reserve_actual, o?.end_actual];
    return reserve == null || end == null ? null : reserve + end;
  });

  /** Fino a due anni avanti: abbastanza per pianificare anche l'anno dopo. */
  protected readonly nextMonths = computed(() => Array.from({ length: 24 }, (_, i) => shiftMonth(this.ledger.month(), i + 1)));

  protected fmtN(cents: number | null | undefined): string {
    return cents == null ? '—' : formatCents(cents);
  }

  protected pct(value: number | null): string {
    return value === null ? '—' : percent.format(value / 100);
  }

  protected tone(r: Row): 'better' | 'worse' | 'even' {
    return diffTone(r.kind, r.forecast, r.actual);
  }

  protected arrow(r: Row): string {
    return { better: ' ↑', worse: ' ↓', even: '' }[this.tone(r)];
  }

  protected forecastText(r: Row): string {
    return signedText(r.forecast, r.kind);
  }

  /** Campo vuoto = previsto a zero. */
  protected async setForecast(r: Row, e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const amount = inputToForecast(input.value, r.kind);
    if (amount === undefined) {
      this.snackBar.open('Importo non valido', 'OK', { duration: 4000 });
      input.value = this.forecastText(r);
      return;
    }
    this.done(await updateLine(r.id, { amount_cents: amount ?? 0 }), 'Previsione non salvata');
  }

  /** Il tipo fissa il nome e, per il prelievo, il secchio; l'arrotondamento parte dal secchio del risparmio. */
  protected pickType(type: ReserveLineType | ''): void {
    this.newType = type;
    this.newBucket = type === 'withdrawal' ? 'entrate' : type === 'roundup' ? (this.ledger.settings()?.savings_bucket_id ?? '') : '';
  }

  protected async addRow(): Promise<void> {
    const name = this.newType ? RESERVE_LINES[this.newType].name : this.newName.trim();
    const bucketId = this.newBucket === 'entrate' ? null : this.newBucket;
    const amount = inputToForecast(this.newAmount, lineKind(bucketId));
    if (!name || !this.newBucket || amount === undefined) {
      this.snackBar.open('Scrivi un nome, scegli il secchio e un importo valido', 'OK', { duration: 4000 });
      return;
    }
    const order = Math.max(0, ...this.rows().map((r) => r.sort_order)) + 1;
    const res = await addLine(this.ledger.month(), name, bucketId, amount ?? 0, order, !!bucketId && this.newOverGood);
    if (res.error?.message.includes('budget_lines_name_uq')) {
      this.snackBar.open(`C'è già una riga ${name} in questo mese`, 'OK', { duration: 4000 });
      return;
    }
    if (this.done(res, 'Riga non aggiunta')) {
      this.newName = '';
      this.newAmount = '';
      this.newOverGood = false;
      this.pickType('');
    }
  }

  protected async renameRow(r: Row): Promise<void> {
    const name = prompt('Nuovo nome della riga', r.name)?.trim();
    if (!name || name === r.name) return;
    this.done(await updateLine(r.id, { name }), 'Riga non rinominata');
  }

  /** Copia le righe di questo mese nei mesi successivi: sostituisce quelle con lo stesso nome, lascia le altre. */
  protected async copy(): Promise<void> {
    const from = this.ledger.month();
    const until = this.copyUntil;
    const lines = this.rows().map((r) => ({ name: r.name, bucket_id: r.bucket_id, forecast: r.forecast, sort_order: r.sort_order, over_is_good: r.over_is_good }));
    if (!until || until <= from) return;
    if (!lines.length) {
      this.snackBar.open('Questo mese non ha righe da copiare', 'OK', { duration: 4000 });
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

  /** Via la riga: i suoi movimenti tornano da assegnare. */
  protected async deleteRow(r: Row): Promise<void> {
    const back = r.n ? ` ${r.n === 1 ? 'Il suo movimento torna' : `I suoi ${r.n} movimenti tornano`} da assegnare.` : '';
    if (!confirm(`Eliminare la riga ${r.name} da ${monthLabel(this.ledger.month())}?${back}`)) return;
    this.done(await deleteLine(r.id), 'Riga non eliminata');
  }

  /** Trascinamento in un altro secchio: stessa operazione del menu. */
  protected drop(e: CdkDragDrop<Group, Group, Row>): void {
    const to = e.container.data.bucketId;
    if (to && e.container !== e.previousContainer) void this.moveRow(e.item.data, to);
  }

  /** I movimenti seguono la riga: il secchio si legge dalla riga. */
  protected async moveRow(r: Row, bucketId: string): Promise<void> {
    this.moving.set({ id: r.id, to: bucketId });
    const res = await updateLine(r.id, { bucket_id: bucketId });
    if (res.error) this.snackBar.open(`Riga non spostata: ${errorText(res)}`, 'OK');
    await this.ledger.load();
    this.moving.set(null);
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): boolean {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.ledger.load();
    return !res.error;
  }
}
