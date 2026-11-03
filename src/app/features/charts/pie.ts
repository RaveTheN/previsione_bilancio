import { Component, computed, effect, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { Chart } from 'chart.js';
import { formatCents } from '../../core/money';
import { darkSignal, themeColors } from './chart';
import { formatPct, PieNode } from './chart-data';

/** La torta delle uscite: toccando una fetta, o la sua riga, si apre nelle sue parti. L'elenco ha gli stessi numeri e si usa anche da tastiera. */
@Component({
  selector: 'app-pie',
  template: `
    <figure>
      <figcaption>
        <h2>Dove vanno i soldi</h2>
        <p>{{ summary() }}</p>
      </figcaption>
      <nav aria-label="Livelli della torta">
        @for (step of trail(); track step.key; let i = $index, last = $last) {
          @if (last) {
            <strong aria-current="location">{{ step.label }}</strong>
          } @else {
            <button type="button" (click)="path.set(path().slice(0, i))">{{ step.label }}</button>
            <span aria-hidden="true">›</span>
          }
        }
      </nav>
      @if (slices().length) {
        <div class="plot">
          <canvas #canvas role="img" [attr.aria-label]="node().label + '. ' + summary()"></canvas>
        </div>
        <ul>
          @for (n of node().children; track n.key) {
            <li>
              <button type="button" [disabled]="!n.children.length" (click)="open(n)">
                <i aria-hidden="true" [style.background]="n.cents > 0 ? color(n) : 'none'"></i>
                <span class="name">{{ n.label }}</span>
                <span class="num">{{ fmt(n.cents) }}</span>
                <span class="num pct">{{ share(n) }}</span>
                <span class="more" aria-hidden="true">{{ n.children.length ? '›' : '' }}</span>
              </button>
            </li>
          }
        </ul>
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
      grid-template-columns: minmax(0, 1fr);
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
    nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      min-height: 44px;
      font: var(--mat-sys-label-large);
    }
    nav strong {
      color: var(--mat-sys-on-surface);
    }
    nav button {
      min-height: 44px;
      padding: 0 4px;
      border: 0;
      background: none;
      color: var(--mat-sys-primary);
      font: inherit;
      cursor: pointer;
    }
    .plot {
      position: relative;
      height: 240px;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li button {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr) auto 3.5em 12px;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 44px;
      padding: 0;
      border: 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
      text-align: left;
      cursor: pointer;
    }
    /* Una fetta senza dettaglio è solo un dato: resta leggibile come le altre (Safari attenua i pulsanti disattivati). */
    li button:disabled {
      -webkit-text-fill-color: currentColor;
      opacity: 1;
      cursor: default;
    }
    i {
      width: 12px;
      height: 12px;
      border-radius: 2px;
    }
    .name {
      overflow-wrap: anywhere;
    }
    .num {
      text-align: right;
      white-space: nowrap;
    }
    .pct {
      color: var(--mat-sys-on-surface-variant);
    }
    .more {
      color: var(--mat-sys-primary);
    }
  `,
})
export class PieView {
  readonly tree = input.required<PieNode>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly dark = darkSignal();
  protected readonly fmt = formatCents;
  /** Le chiavi delle fette aperte: se il periodo cambia e una non c'è più, ci si ferma al livello sopra. */
  protected readonly path = signal<string[]>([]);

  protected readonly trail = computed(() => {
    const steps = [this.tree()];
    for (const key of this.path()) {
      const next = steps[steps.length - 1].children.find((n) => n.key === key);
      if (!next) break;
      steps.push(next);
    }
    return steps;
  });
  protected readonly node = computed(() => this.trail()[this.trail().length - 1]);
  /** Un rimborso più grande della spesa dà un valore negativo: sta nell'elenco, ma non può essere una fetta. */
  protected readonly slices = computed(() => this.node().children.filter((n) => n.cents > 0));
  private readonly slicesTotal = computed(() => this.slices().reduce((s, n) => s + n.cents, 0));

  protected readonly summary = computed(() => {
    const slices = this.slices();
    if (!slices.length) return 'Nessuna uscita nel periodo.';
    const first = slices.reduce((a, b) => (b.cents > a.cents ? b : a));
    const hint = slices.some((n) => n.children.length) ? ' Tocca una fetta per il dettaglio.' : '';
    return `Totale ${formatCents(this.node().cents)}. Al primo posto ${first.label}, con il ${this.share(first)}.${hint}`;
  });

  constructor() {
    // Niente animazioni: come negli altri grafici, si ridisegna da zero a ogni cambio.
    effect((onCleanup) => {
      const canvas = this.canvas()?.nativeElement;
      const slices = this.slices();
      const dark = this.dark();
      if (!canvas) return;
      const c = themeColors(this.host.nativeElement, dark);
      const chart = new Chart(canvas, {
        type: 'pie',
        data: {
          labels: slices.map((n) => n.label),
          datasets: [{ data: slices.map((n) => n.cents), backgroundColor: slices.map((n) => c.series[n.slot]), borderColor: c.surface, borderWidth: 2 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              borderColor: c.grid,
              borderWidth: 1,
              callbacks: { label: (item) => `${formatCents(item.raw as number)} · ${this.share(slices[item.dataIndex])}` },
            },
          },
          onClick: (_, elements) => {
            const n = slices[elements[0]?.index];
            if (n?.children.length) this.open(n);
          },
          onHover: (event, elements) => {
            (event.native?.target as HTMLElement).style.cursor = slices[elements[0]?.index]?.children.length ? 'pointer' : 'default';
          },
        },
      });
      onCleanup(() => chart.destroy());
    });
  }

  protected open(n: PieNode): void {
    this.path.set([...this.trail().slice(1).map((s) => s.key), n.key]);
  }

  protected color(n: PieNode): string {
    return themeColors(this.host.nativeElement, this.dark()).series[n.slot];
  }

  protected share(n: PieNode): string {
    return n.cents > 0 && this.slicesTotal() ? formatPct(Math.round((n.cents / this.slicesTotal()) * 1000) / 10) : '';
  }
}
