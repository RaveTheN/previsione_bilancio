import { Component, computed, Directive, inject } from '@angular/core';
import { Ledger, monthLabel, shiftMonth } from '../core/ledger';

@Component({
  selector: 'app-month-header',
  template: `
    <header>
      <button type="button" aria-label="Mese precedente" (click)="move(-1)">
        <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z" /></svg>
      </button>
      <h1>{{ label() }}</h1>
      <button type="button" aria-label="Mese successivo" (click)="move(1)">
        <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" /></svg>
      </button>
    </header>
  `,
  styles: `
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-title-large);
    }
    button {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border: 0;
      border-radius: 50%;
      background: none;
      color: var(--mat-sys-on-surface);
      cursor: pointer;
    }
    svg {
      width: 28px;
      height: 28px;
      fill: currentColor;
    }
  `,
})
export class MonthHeader {
  private readonly ledger = inject(Ledger);
  protected readonly label = computed(() => monthLabel(this.ledger.month()));

  protected move(delta: number): void {
    this.ledger.month.update((m) => shiftMonth(m, delta));
  }
}

/** Swipe orizzontale per cambiare mese; le frecce restano l'alternativa accessibile. */
@Directive({
  selector: '[appSwipeMonth]',
  host: {
    style: 'touch-action: pan-y',
    '(pointerdown)': 'start($event)',
    '(pointerup)': 'end($event)',
    '(pointercancel)': 'x0 = null',
  },
})
export class SwipeMonth {
  private readonly ledger = inject(Ledger);
  protected x0: number | null = null;
  private y0 = 0;

  start(e: PointerEvent): void {
    // I primi 24 px a sinistra appartengono al gesto "indietro" di iOS.
    this.x0 = e.pointerType === 'mouse' || e.clientX < 24 ? null : e.clientX;
    this.y0 = e.clientY;
  }

  end(e: PointerEvent): void {
    if (this.x0 === null) return;
    const dx = e.clientX - this.x0;
    const dy = e.clientY - this.y0;
    this.x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) {
      this.ledger.month.update((m) => shiftMonth(m, dx < 0 ? 1 : -1));
    }
  }
}
