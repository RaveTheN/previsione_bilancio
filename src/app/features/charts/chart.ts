import { Component, computed, DestroyRef, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { BarController, BarElement, CategoryScale, Chart, ChartConfiguration, Legend, LinearScale, LineController, LineElement, Plugin, PointElement, Tooltip } from 'chart.js';
import { formatCents } from '../../core/money';
import { ChartSpec, formatPct } from './chart-data';

// Solo i pezzi usati: il resto di Chart.js non entra nel pacchetto.
Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Legend, Tooltip);
Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Una tinta per modo: controllate con il validatore sui fondi dell'app. Il primo è il grigio di previsioni e "Altre".
const PALETTE = {
  light: ['#898781', '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'],
  dark: ['#898781', '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9'],
};

interface Colors {
  series: string[];
  surface: string;
  ink: string;
  grid: string;
}

/** Il valore in fondo alla barra, per i grafici con una sola serie: si legge senza toccare. */
const tipLabels = (format: (value: number) => string, ink: string): Plugin<'bar'> => ({
  id: 'tipLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = ink;
    ctx.textBaseline = 'middle';
    ctx.font = `12px ${Chart.defaults.font.family}`;
    chart.getDatasetMeta(0).data.forEach((bar, i) => ctx.fillText(format(chart.data.datasets[0].data[i] as number), bar.x + 6, bar.y));
    ctx.restore();
  },
});

function config(spec: ChartSpec, c: Colors): ChartConfiguration {
  const horizontal = spec.form === 'bars';
  const stacked = spec.form === 'columns';
  const isBar = spec.form !== 'line';
  // Con una sola serie il valore è sulla barra: l'asse non serve.
  const tips = horizontal && spec.series.length === 1;
  const format = spec.unit === 'pct' ? formatPct : formatCents;
  const tick = (value: number) => (spec.unit === 'pct' ? `${value}%` : `${Math.round(value / 100).toLocaleString('it-IT')} €`);

  const value = {
    stacked,
    beginAtZero: isBar,
    display: !tips,
    suggestedMax: spec.ticks?.at(-1),
    // Gli obiettivi stanno sopra le colonne: si confrontano con il bordo di ogni fascia.
    grid: { color: spec.ticks ? c.ink : c.grid, z: spec.ticks ? 1 : 0 },
    border: { display: false },
    afterBuildTicks: spec.ticks ? (axis: { ticks: { value: number }[] }) => (axis.ticks = spec.ticks!.map((t) => ({ value: t }))) : undefined,
    ticks: { color: c.ink, maxTicksLimit: 6, callback: (v: number | string) => tick(Number(v)) },
  };
  const category = {
    stacked,
    grid: { display: false },
    border: { color: c.grid },
    ticks: {
      color: c.ink,
      autoSkip: !horizontal,
      maxRotation: 0,
      callback(this: { getLabelForValue(v: number): string }, v: number | string) {
        const label = this.getLabelForValue(Number(v));
        return label.length > 18 ? label.slice(0, 17) + '…' : label;
      },
    },
  };

  return {
    type: isBar ? 'bar' : 'line',
    data: {
      labels: spec.labels,
      datasets: spec.series.map((s, i) => {
        const color = c.series[s.slot];
        return isBar
          ? {
              label: s.label,
              data: s.values,
              backgroundColor: color,
              // Il bordo del colore del fondo stacca le barre vicine.
              borderColor: c.surface,
              borderWidth: 1,
              borderSkipped: 'start',
              // Nelle colonne impilate si arrotonda solo la fascia in cima.
              borderRadius: !stacked || i === spec.series.length - 1 ? 4 : 0,
              maxBarThickness: horizontal ? 16 : 24,
            }
          : {
              label: s.label,
              data: s.values,
              borderColor: color,
              backgroundColor: color,
              borderWidth: 2,
              borderDash: s.dashed ? [6, 4] : [],
              pointRadius: 4,
              pointHoverRadius: 5,
              pointBorderColor: c.surface,
              pointBorderWidth: 2,
            };
      }),
    } as ChartConfiguration['data'],
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // Basta il tocco vicino alla colonna: il riquadro riporta tutte le serie di quel punto.
      interaction: { mode: 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
      layout: { padding: { right: tips ? 72 : 0 } },
      scales: (horizontal ? { x: value, y: category } : { x: category, y: value }) as never,
      plugins: {
        // La legenda riprende il segno: un riquadro alto zero è un tratto, tratteggiato per la previsione.
        legend: {
          display: spec.series.length > 1,
          align: 'start',
          labels: { color: c.ink, boxWidth: isBar ? 12 : 28, boxHeight: isBar ? 12 : 0 },
        },
        tooltip: {
          borderColor: c.grid,
          borderWidth: 1,
          filter: (item) => item.raw !== null,
          callbacks: { label: (item) => `${format(item.raw as number)} · ${item.dataset.label}` },
        },
      },
    },
    plugins: tips ? [tipLabels(format, c.ink) as Plugin] : [],
  };
}

/** Un grafico con titolo, riepilogo a parole e tabella con gli stessi numeri: il colore e il tocco non sono mai l'unica via. */
@Component({
  selector: 'app-chart',
  template: `
    <figure>
      <figcaption>
        <h2>{{ heading() }}</h2>
        <p>{{ spec().summary }}</p>
      </figcaption>
      @if (spec().labels.length) {
        <div class="plot" [style.height.px]="height()">
          <canvas #canvas role="img" [attr.aria-label]="heading() + '. ' + spec().summary"></canvas>
        </div>
        <details>
          <summary>Vedi i numeri</summary>
          <div class="scroll" tabindex="0" role="region" [attr.aria-label]="'Numeri: ' + heading()">
            <table>
              <thead>
                <tr>
                  <td></td>
                  @for (s of spec().series; track s.label) {
                    <th scope="col">{{ s.label }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (label of spec().labels; track $index; let i = $index) {
                  <tr>
                    <th scope="row">{{ label }}</th>
                    @for (s of spec().series; track s.label) {
                      <td>{{ cell(s.values[i]) }}</td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </details>
      }
    </figure>
  `,
  styles: `
    /* Colori letti dal codice per il disegno: così seguono il tema del sistema. */
    :host {
      display: block;
      min-width: 0;
      color: var(--mat-sys-on-surface-variant);
      border-color: var(--mat-sys-outline-variant);
    }
    figure {
      display: grid;
      gap: 8px;
      margin: 0;
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-medium);
      color: var(--mat-sys-on-surface);
    }
    p {
      margin: 4px 0 0;
      font: var(--mat-sys-body-small);
    }
    .plot {
      position: relative;
      min-width: 0;
    }
    summary {
      display: flex;
      align-items: center;
      min-height: 44px;
      cursor: pointer;
      font: var(--mat-sys-label-large);
      color: var(--mat-sys-primary);
    }
    summary::before {
      content: '›';
      margin-right: 8px;
    }
    details[open] summary::before {
      content: '⌄';
    }
    .scroll {
      overflow-x: auto;
    }
    table {
      border-collapse: collapse;
      font: var(--mat-sys-body-small);
      white-space: nowrap;
    }
    th,
    td {
      padding: 4px 8px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    th {
      font-weight: 500;
    }
    th[scope='row'] {
      text-align: left;
    }
  `,
})
export class ChartView {
  readonly heading = input.required<string>();
  readonly spec = input.required<ChartSpec>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly dark = signal(false);

  /** Le barre crescono con le righe; il resto ha un'altezza fissa, assi compresi. */
  protected readonly height = computed(() => {
    const spec = this.spec();
    if (spec.form !== 'bars') return 280;
    return spec.labels.length * (spec.series.length > 1 ? 44 : 30) + (spec.series.length > 1 ? 64 : 8);
  });

  constructor() {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => this.dark.set(media.matches);
    update();
    media.addEventListener('change', update);
    inject(DestroyRef).onDestroy(() => media.removeEventListener('change', update));

    // Niente animazioni: ridisegnare da zero non si vede, ed è il modo più semplice di seguire dati e tema.
    effect((onCleanup) => {
      const canvas = this.canvas()?.nativeElement;
      const spec = this.spec();
      const dark = this.dark();
      if (!canvas) return;
      const style = getComputedStyle(this.host.nativeElement);
      const chart = new Chart(
        canvas,
        config(spec, {
          series: dark ? PALETTE.dark : PALETTE.light,
          surface: getComputedStyle(document.body).backgroundColor,
          ink: style.color,
          grid: style.borderTopColor,
        }),
      );
      onCleanup(() => chart.destroy());
    });
  }

  protected cell(value: number | null): string {
    if (value === null) return '—';
    return this.spec().unit === 'pct' ? formatPct(value) : formatCents(value);
  }
}
