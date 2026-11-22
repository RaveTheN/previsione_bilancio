import { Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Ledger, monthLabel } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { LongPress } from '../../shared/long-press';
import { ChartMonth, formatPct, monthRow, topGaps } from './chart-data';

/**
 * I mesi del periodo in un elenco: entrate, uscite, disponibile e Salvadanaio a fine mese.
 * Tenendo premuta una riga (o toccando il nome del mese) si aprono le statistiche del mese.
 */
@Component({
  selector: 'app-month-summary',
  imports: [LongPress],
  template: `
    <h2>Riepilogo dei mesi</h2>
    <p class="note">L'effettivo fino al mese in corso, il previsto per i mesi futuri. Tieni premuto un mese per le sue statistiche.</p>
    <div class="scroll" tabindex="0" role="region" aria-label="Riepilogo dei mesi">
      <table>
        <thead>
          <tr>
            <th scope="col">Mese</th>
            <th scope="col">Entrate</th>
            <th scope="col">Uscite</th>
            <th scope="col">Disponibile</th>
            <th scope="col">Salvadanaio</th>
          </tr>
        </thead>
        <tbody>
          @for (r of rows(); track r.month) {
            <tr class="month" [class.future]="r.month > current()" (appLongPress)="toggle(r.month)">
              <th scope="row">
                <button type="button" [attr.aria-expanded]="open() === r.month" (click)="toggle(r.month)">{{ short(r.month) }} <span aria-hidden="true">▾</span></button>
              </th>
              <td>{{ fmt(r.income) }}</td>
              <td>{{ fmt(r.expense) }}</td>
              <td>{{ fmtN(r.end) }}</td>
              <td>{{ fmtN(r.reserve) }}</td>
            </tr>
            @if (open() === r.month && detail(); as m) {
              <tr class="detail">
                <td colspan="5">
                  <h3>{{ label(m.month) }}</h3>
                  <dl>
                    <dt>Entrate</dt>
                    <dd>{{ pair(m.income_actual, m.income_forecast) }}</dd>
                    <dt>Uscite</dt>
                    <dd>{{ pair(m.expense_actual, m.expense_forecast) }}</dd>
                    <dt>Accantonato</dt>
                    <!-- || 0: il meno di zero stamperebbe "-0,00 €". -->
                    <dd>{{ pair(-m.saving_actual || 0, -m.saving_forecast || 0) }}</dd>
                    <dt>Disponibile a fine mese</dt>
                    <dd>{{ m.end_forecast === null ? '—' : pair(m.end_actual ?? 0, m.end_forecast) }}</dd>
                    @for (b of m.buckets; track b.bucket_id) {
                      <dt>{{ ledger.bucketById().get(b.bucket_id)?.name }}</dt>
                      <dd>{{ pct(future() ? b.forecast_pct : b.actual_pct) }} delle entrate · obiettivo {{ pct(b.target_pct) }}</dd>
                    }
                    @if (m.debt_cents) {
                      <dt>Rate del mese</dt>
                      <dd>{{ fmt(m.debt_cents) }}{{ m.debt_pct === null ? '' : ' · ' + pct(m.debt_pct) + ' delle entrate' }}</dd>
                    }
                    @if (m.unassigned.n) {
                      <dt>Da assegnare</dt>
                      <dd>{{ m.unassigned.n }} movimenti · {{ fmt(m.unassigned.actual) }}</dd>
                    }
                    @if (!future()) {
                      @for (l of gaps(); track l.id) {
                        <dt>{{ l.name }}</dt>
                        <dd>{{ pair(l.actual, l.forecast) }}</dd>
                      }
                    }
                  </dl>
                  <div class="actions">
                    <button type="button" (click)="open.set('')">Chiudi</button>
                    <button type="button" (click)="openMonth(m.month)">Apri il mese</button>
                  </div>
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    h3 {
      margin: 0 0 4px;
      font: var(--mat-sys-title-small);
    }
    .note {
      margin: 0;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .scroll {
      overflow-x: auto;
    }
    table {
      width: 100%;
      max-width: 720px;
      border-collapse: collapse;
      font: var(--mat-sys-body-medium);
      white-space: nowrap;
    }
    th,
    td {
      padding: 0 8px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    thead th {
      padding: 6px 8px;
      font: var(--mat-sys-label-medium);
      color: var(--mat-sys-on-surface-variant);
    }
    th:first-child {
      padding-left: 0;
      text-align: left;
    }
    .future td {
      color: var(--mat-sys-on-surface-variant);
    }
    button {
      min-height: 44px;
      padding: 0;
      border: 0;
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }
    .month button span,
    .actions button {
      color: var(--mat-sys-primary);
    }
    .detail td {
      padding: 12px;
      background: var(--mat-sys-surface-container);
      text-align: left;
      white-space: normal;
    }
    dl {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 4px 12px;
      margin: 0;
    }
    dt {
      color: var(--mat-sys-on-surface-variant);
    }
    dd {
      margin: 0;
      text-align: right;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 24px;
    }
  `,
})
export class MonthSummary {
  readonly months = input.required<ChartMonth[]>();
  readonly current = input.required<string>();

  protected readonly ledger = inject(Ledger);
  private readonly router = inject(Router);
  protected readonly fmt = formatCents;
  protected readonly label = monthLabel;
  /** Il mese con le statistiche aperte. */
  protected readonly open = signal('');

  protected readonly rows = computed(() => this.months().map((m) => monthRow(m, this.current())));
  protected readonly detail = computed(() => this.months().find((m) => m.month === this.open()));
  protected readonly future = computed(() => this.open() > this.current());
  protected readonly gaps = computed(() => topGaps(this.detail()!));

  protected toggle(month: string): void {
    this.open.update((m) => (m === month ? '' : month));
  }

  protected short(month: string): string {
    return new Date(month + 'T12:00:00').toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
  }

  protected fmtN(cents: number | null): string {
    return cents === null ? '—' : formatCents(cents);
  }

  protected pct(value: number | null): string {
    return value === null ? '—' : formatPct(value);
  }

  /** "Effettivo su previsto"; per un mese futuro c'è solo il previsto. */
  protected pair(actual: number, forecast: number): string {
    return this.future() ? `${formatCents(forecast)} previsti` : `${formatCents(actual)} su ${formatCents(forecast)} previsti`;
  }

  protected openMonth(month: string): void {
    this.ledger.month.set(month);
    void this.router.navigate(['/mese']);
  }
}
