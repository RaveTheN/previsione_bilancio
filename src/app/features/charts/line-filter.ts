import { Component, input, model } from '@angular/core';

/** Le righe a cui si riferisce un grafico: tutte, salvo quelle a cui togli la spunta. */
@Component({
  selector: 'app-line-filter',
  template: `
    <details>
      <summary>Righe: {{ excludedHere() ? names().length - excludedHere() + ' su ' + names().length : 'tutte' }}</summary>
      <div class="tools">
        <button type="button" (click)="excluded.set([])">Tutte</button>
        <button type="button" (click)="excluded.set(names())">Nessuna</button>
      </div>
      @for (n of names(); track n) {
        <label>
          <input type="checkbox" [checked]="!excluded().includes(n)" (change)="toggle(n)" />
          {{ n }}
        </label>
      } @empty {
        <p>Nessuna riga nel periodo.</p>
      }
    </details>
  `,
  styles: `
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
    .tools {
      display: flex;
      gap: 8px;
    }
    button {
      min-height: 40px;
      padding: 0 14px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 20px;
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }
    label {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
    }
    input {
      flex: none;
      width: 22px;
      height: 22px;
    }
    p {
      margin: 0;
      font: var(--mat-sys-body-small);
    }
  `,
})
export class LineFilter {
  readonly names = input.required<string[]>();
  /** I nomi esclusi: restano tali anche se nel periodo scelto la riga non c'è. */
  readonly excluded = model<string[]>([]);

  protected excludedHere(): number {
    return this.names().filter((n) => this.excluded().includes(n)).length;
  }

  protected toggle(name: string): void {
    this.excluded.update((list) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]));
  }
}
