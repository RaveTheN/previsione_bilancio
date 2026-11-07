import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { currentMonth, Ledger } from '../../core/ledger';
import { errorText, supabase } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { ChartView } from './chart';
import { bucketChart, ChartData, lineChart, merchantChart, periodOptions, periodRange, savingsChart, spendingTree } from './chart-data';
import { PieView } from './pie';

/** Il filtro del periodo vale per tutti i grafici: i numeri sono quelli di griglia e vista mese. */
@Component({
  selector: 'app-charts',
  imports: [ChartView, FormsModule, PieView],
  template: `
    <h1>Grafici</h1>
    <label>
      Periodo
      <select name="period" [ngModel]="period()" (ngModelChange)="period.set($event)">
        @for (o of options(); track o.value) {
          <option [value]="o.value">{{ o.label }}</option>
        }
      </select>
    </label>
    <p class="note">Torta, scostamenti, secchi ed esercenti arrivano fino al mese in corso.</p>
    @if (error()) {
      <p class="warn" role="alert">{{ error() }}</p>
    }
    <div class="grid" [class.stale]="loading()" [attr.aria-busy]="loading()">
      @if (tree(); as t) {
        <app-pie [tree]="t" />
      }
      @for (c of charts(); track c.heading) {
        <app-chart [heading]="c.heading" [spec]="c.spec" />
      }
    </div>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-title-large);
    }
    label {
      display: flex;
      align-items: center;
      gap: 8px;
      font: var(--mat-sys-label-large);
    }
    select {
      min-height: 44px;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    p {
      margin: 0;
    }
    .note {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .warn {
      color: var(--mat-sys-error);
    }
    /* Una colonna su iPhone, due su iPad, tre su PC. */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
      gap: 32px 24px;
      align-items: start;
      transition: opacity 150ms;
    }
    /* Durante il caricamento restano i grafici di prima, attenuati. */
    .stale {
      opacity: 0.5;
    }
  `,
})
export class Charts {
  private readonly ledger = inject(Ledger);
  private readonly sync = inject(Sync);
  private readonly current = currentMonth();
  private lastRequest = 0;

  protected readonly period = signal(`y${this.current.slice(0, 4)}`);
  protected readonly error = signal('');
  protected readonly loading = signal(false);
  private readonly data = signal<ChartData | null>(null);
  private readonly goLive = computed(() => this.ledger.settings()?.go_live_month ?? null);

  protected readonly options = computed(() => periodOptions(this.current, this.goLive()));

  protected readonly tree = computed(() => {
    const data = this.data();
    return data && spendingTree(data.spending, this.ledger.buckets());
  });

  protected readonly charts = computed(() => {
    const data = this.data();
    if (!data) return [];
    const past = data.months.filter((m) => m.month <= this.current);
    return [
      { heading: 'Risparmio accumulato', spec: savingsChart(data.months, this.current) },
      { heading: 'Uscite: previsto ed effettivo', spec: lineChart(past, 'expense') },
      { heading: 'Entrate: previsto ed effettivo', spec: lineChart(past, 'income') },
      { heading: 'Ripartizione nei secchi', spec: bucketChart(past, this.ledger.buckets()) },
      { heading: 'Top esercenti', spec: merchantChart(data.merchants) },
    ];
  });

  constructor() {
    effect(() => {
      const period = this.period();
      const goLive = this.goLive();
      this.sync.synced();
      untracked(() => void this.load(period, goLive));
    });
  }

  private async load(period: string, goLive: string | null): Promise<void> {
    const request = ++this.lastRequest;
    this.loading.set(true);
    const { from, to } = periodRange(period, this.current, goLive);
    // In GET: il service worker la conserva per la lettura offline.
    const res = await supabase.rpc('chart_data', { p_from: from, p_to: to }, { get: true });
    // Una risposta lenta di una richiesta superata non sovrascrive quella mostrata.
    if (request !== this.lastRequest) return;
    this.loading.set(false);
    this.error.set(res.error ? 'Grafici non aggiornati: ' + errorText(res) : '');
    if (res.data) this.data.set(res.data as unknown as ChartData);
  }
}
