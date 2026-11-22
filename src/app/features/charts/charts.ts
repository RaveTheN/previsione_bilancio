import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { currentMonth, Ledger, monthLabel, shiftMonth, todayIso } from '../../core/ledger';
import { errorText, supabase } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { ChartView } from './chart';
import {
  balanceChart,
  bucketChart,
  ChartData,
  clampRange,
  compareChart,
  compareDay,
  dailyChart,
  DaySpend,
  daySpending,
  debtChart,
  lineChart,
  lineNames,
  marginChart,
  merchantChart,
  periodOptions,
  periodRange,
  RawMovement,
  savingsChart,
  spendingTree,
  topMerchants,
  totalChart,
  withoutLines,
} from './chart-data';
import { LineFilter } from './line-filter';
import { MonthSummary } from './month-summary';
import { PieView } from './pie';

const EXCLUDED_KEY = 'bilancio.grafici.righe';

/** Le righe tolte da ogni grafico, per nome: restano da una visita all'altra. */
function readExcluded(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Il periodo vale per tutti i grafici, salvo confronto e andamento che hanno i loro mesi: i numeri sono quelli di griglia e vista mese. */
@Component({
  selector: 'app-charts',
  imports: [ChartView, LineFilter, MonthSummary, PieView],
  template: `
    <h1>Grafici</h1>
    <div class="period">
      <label>
        Da
        <input type="month" [value]="range().from.slice(0, 7)" (change)="setRange('from', $any($event.target).value)" />
      </label>
      <label>
        a
        <input type="month" [value]="range().to.slice(0, 7)" (change)="setRange('to', $any($event.target).value)" />
      </label>
      <select aria-label="Scorciatoie del periodo" (change)="shortcut($any($event.target))">
        <option value="">Scorciatoie…</option>
        @for (o of options(); track o.value) {
          <option [value]="o.value">{{ o.label }}</option>
        }
      </select>
    </div>
    <p class="note">
      Disponibile, risparmio, totale, margine e rate mostrano anche la previsione dei mesi futuri e riguardano tutto il bilancio; negli altri
      grafici puoi scegliere le righe, e arrivano fino al mese in corso.
    </p>
    @if (error()) {
      <p class="warn" role="alert">{{ error() }}</p>
    }
    <div class="grid" [class.stale]="loading()" [attr.aria-busy]="loading()">
      @if (tree(); as t) {
        <app-pie [tree]="t" />
      }
      @for (c of charts(); track c.heading) {
        <app-chart [heading]="c.heading" [spec]="c.spec" (pick)="c.key === 'esercenti' && openMerchant($event)">
          @if (c.key === 'confronto') {
            <div class="months">
              <select aria-label="Mese da confrontare" [value]="monthA()" (change)="monthA.set($any($event.target).value)">
                @for (m of pastMonths(); track m) {
                  <option [value]="m" [selected]="m === monthA()">{{ label(m) }}</option>
                }
              </select>
              <span>contro</span>
              <select aria-label="Mese di confronto" [value]="monthB()" (change)="monthB.set($any($event.target).value)">
                @for (m of pastMonths(); track m) {
                  <option [value]="m" [selected]="m === monthB()">{{ label(m) }}</option>
                }
              </select>
            </div>
          }
          @if (c.key === 'giornaliero') {
            <div class="months">
              <select aria-label="Mese dell'andamento giornaliero" [value]="dayMonth()" (change)="dayMonth.set($any($event.target).value)">
                @for (m of pastMonths(); track m) {
                  <option [value]="m" [selected]="m === dayMonth()">{{ label(m) }}</option>
                }
              </select>
            </div>
          }
          @if (c.key === 'esercenti') {
            <p class="note">Tocca un esercente per aprirlo in Rubrica, con la spesa mese per mese.</p>
          }
          @if (c.lines; as names) {
            <app-line-filter [names]="names" [excluded]="excluded()[c.key] ?? []" (excludedChange)="setExcluded(c.key, $event)" />
          }
        </app-chart>
      }
    </div>
    @if (data(); as d) {
      <app-month-summary [months]="d.months" [current]="current" />
    }
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
    .period,
    .months,
    label {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      font: var(--mat-sys-label-large);
    }
    select,
    input {
      min-width: 0;
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
  private readonly router = inject(Router);
  protected readonly current = currentMonth();
  protected readonly label = monthLabel;
  private lastRequest = 0;
  private lastDays = 0;

  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly data = signal<ChartData | null>(null);
  private readonly goLive = computed(() => this.ledger.settings()?.go_live_month ?? null);

  /** Il periodo scelto, da mese a mese; le scorciatoie lo riempiono. */
  private readonly chosen = signal(periodRange(`y${this.current.slice(0, 4)}`, this.current, null));
  protected readonly range = computed(() => clampRange(this.chosen().from, this.chosen().to, this.goLive()));
  protected readonly options = computed(() => periodOptions(this.current, this.goLive()));

  /** Confronto e andamento hanno i loro mesi: di default quello in corso contro il precedente. */
  protected readonly monthA = signal(this.current);
  protected readonly monthB = signal(shiftMonth(this.current, -1));
  protected readonly dayMonth = signal(this.current);
  private readonly days = signal<DaySpend[]>([]);
  /** Dal mese in corso indietro fino all'avvio (senza avvio, un anno). */
  protected readonly pastMonths = computed(() => {
    const first = this.goLive() ?? shiftMonth(this.current, -11);
    const months = [this.current];
    while (months[months.length - 1] > first && months.length < 36) months.push(shiftMonth(months[months.length - 1], -1));
    // Il mese prima dell'avvio resta scelto finché non lo cambi: senza la sua voce la tendina mostrerebbe altro.
    return [...new Set([...months, this.monthA(), this.monthB(), this.dayMonth()])].sort().reverse();
  });

  protected readonly excluded = signal(readExcluded());

  protected readonly tree = computed(() => {
    const data = this.data();
    return data && spendingTree(data.spending, this.ledger.buckets());
  });

  protected readonly charts = computed(() => {
    const data = this.data();
    if (!data) return [];
    const past = data.months.filter((m) => m.month <= this.current);
    const out = (key: string) => new Set(this.excluded()[key] ?? []);
    const expenses = lineNames(past, 'expense');
    // Le righe dei mesi a confronto possono non essere nel periodo scelto.
    const dayLines = [...new Set([...expenses, ...this.days().flatMap((r) => r.line ?? [])])].sort((a, b) => a.localeCompare(b, 'it'));
    const days = (key: string) => this.days().filter((r) => !r.line || !out(key).has(r.line));
    const buckets = this.ledger.buckets();
    return [
      {
        key: 'confronto',
        heading: 'Confronto tra due mesi',
        spec: compareChart(days('confronto'), this.monthA(), this.monthB(), compareDay(this.monthA(), todayIso()), buckets),
        lines: dayLines,
      },
      { key: 'giornaliero', heading: 'Andamento giornaliero', spec: dailyChart(days('giornaliero'), this.dayMonth(), todayIso()), lines: dayLines },
      { key: 'disponibile', heading: 'Disponibile a fine mese', spec: balanceChart(data.months, this.current) },
      { key: 'risparmio', heading: 'Risparmio accumulato', spec: savingsChart(data.months, this.current) },
      { key: 'totale', heading: 'Totale: disponibile più Salvadanaio', spec: totalChart(data.months, this.current) },
      { key: 'margine', heading: 'Margine del mese', spec: marginChart(data.months, this.current) },
      { key: 'rate', heading: 'Rate dei debiti', spec: debtChart(data.months) },
      { key: 'uscite', heading: 'Uscite: previsto ed effettivo', spec: lineChart(withoutLines(past, out('uscite')), 'expense'), lines: expenses },
      { key: 'entrate', heading: 'Entrate: previsto ed effettivo', spec: lineChart(withoutLines(past, out('entrate')), 'income'), lines: lineNames(past, 'income') },
      { key: 'secchi', heading: 'Ripartizione nei secchi', spec: bucketChart(withoutLines(past, out('secchi')), buckets), lines: expenses },
      {
        key: 'esercenti',
        heading: 'Top esercenti',
        spec: merchantChart(topMerchants(data.spending.filter((r) => !r.line || !out('esercenti').has(r.line)))),
        lines: expenses,
      },
    ];
  });

  constructor() {
    effect(() => {
      const range = this.range();
      this.sync.synced();
      untracked(() => void this.load(range));
    });
    effect(() => {
      const months = [...new Set([this.monthA(), this.monthB(), this.dayMonth()])];
      this.sync.synced();
      untracked(() => void this.loadDays(months));
    });
  }

  protected setRange(side: 'from' | 'to', month: string): void {
    // Un campo svuotato non cambia il periodo.
    if (/^\d{4}-\d{2}$/.test(month)) this.chosen.set({ ...this.range(), [side]: month + '-01' });
  }

  /** La tendina torna su "Scorciatoie…": il periodo si legge nei due campi. */
  protected shortcut(select: HTMLSelectElement): void {
    if (select.value) this.chosen.set(periodRange(select.value, this.current, null));
    select.value = '';
  }

  protected setExcluded(key: string, names: string[]): void {
    this.excluded.update((all) => ({ ...all, [key]: names }));
    try {
      localStorage.setItem(EXCLUDED_KEY, JSON.stringify(this.excluded()));
    } catch {
      // Senza spazio sul dispositivo il filtro vale solo per questa visita.
    }
  }

  protected openMerchant(name: string): void {
    void this.router.navigate(['/rubrica'], { queryParams: { cerca: name } });
  }

  private async load(range: { from: string; to: string }): Promise<void> {
    const request = ++this.lastRequest;
    this.loading.set(true);
    // In GET: il service worker la conserva per la lettura offline.
    const res = await supabase.rpc('chart_data', { p_from: range.from, p_to: range.to }, { get: true });
    // Una risposta lenta di una richiesta superata non sovrascrive quella mostrata.
    if (request !== this.lastRequest) return;
    this.loading.set(false);
    this.error.set(res.error ? 'Grafici non aggiornati: ' + errorText(res) : '');
    if (res.data) this.data.set(res.data as unknown as ChartData);
  }

  /** I movimenti dei mesi di confronto e andamento, giorno per giorno. */
  private async loadDays(months: string[]): Promise<void> {
    const request = ++this.lastDays;
    // shortcut: al massimo 1000 movimenti (il limite dell'API) nei mesi scelti; oltre, serve una funzione del database che sommi per giorno.
    const res = await supabase
      .from('transactions')
      .select('booking_date, amount_cents, line_id, transfer_group_id, budget_lines(name, bucket_id)')
      .in('month', months)
      .neq('status', 'declined');
    if (request !== this.lastDays) return;
    if (res.data) this.days.set(daySpending(res.data as unknown as RawMovement[]));
  }
}
