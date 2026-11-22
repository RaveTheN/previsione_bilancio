import { Component, computed, input, model } from '@angular/core';
import { LineGroup } from './chart-data';

/** Le righe a cui si riferisce un grafico: tutte, salvo le righe o gli interi secchi a cui togli la spunta. */
@Component({
  selector: 'app-line-filter',
  template: `
    <details>
      <summary>Righe: {{ shown() === total() ? 'tutte' : shown() + ' su ' + total() }}</summary>
      <div class="tools">
        <button type="button" (click)="excluded.set([])">Tutte</button>
        <button type="button" (click)="excluded.set(everything())">Nessuna</button>
      </div>
      @for (g of groups(); track g.id) {
        @if (g.id) {
          <label class="bucket">
            <input type="checkbox" [checked]="!off(key(g))" (change)="toggle(key(g))" />
            {{ g.title }}
          </label>
        }
        @for (n of g.names; track n) {
          <!-- Con il secchio escluso le sue righe restano come le avevi lasciate, ma non contano. -->
          <label [class.line]="!!g.id">
            <input type="checkbox" [checked]="!off(n)" [disabled]="off(key(g))" (change)="toggle(n)" />
            {{ n }}
          </label>
        }
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
    .bucket {
      font: var(--mat-sys-title-small);
    }
    .line {
      padding-left: 30px;
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
  readonly groups = input.required<LineGroup[]>();
  /** Nomi di righe e secchi interi ("#id") esclusi: restano tali anche se nel periodo scelto non ci sono. */
  readonly excluded = model<string[]>([]);

  protected readonly total = computed(() => this.groups().reduce((s, g) => s + g.names.length, 0));
  protected readonly shown = computed(() => this.groups().reduce((s, g) => s + (this.off(this.key(g)) ? 0 : g.names.filter((n) => !this.off(n)).length), 0));
  protected readonly everything = computed(() => this.groups().flatMap((g) => (g.id ? [this.key(g)] : g.names)));

  protected key(g: LineGroup): string {
    return '#' + g.id;
  }

  protected off(entry: string): boolean {
    return this.excluded().includes(entry);
  }

  protected toggle(entry: string): void {
    this.excluded.update((list) => (list.includes(entry) ? list.filter((n) => n !== entry) : [...list, entry]));
  }
}
