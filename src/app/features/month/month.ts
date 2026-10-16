import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Ledger } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { Sync } from '../../core/sync';
import { MonthHeader, SwipeMonth } from '../../shared/month-header';

interface Group {
  title: string;
  total: number;
  rows: { name: string; cents: number }[];
}

@Component({
  selector: 'app-month',
  imports: [MonthHeader, RouterLink],
  hostDirectives: [SwipeMonth],
  template: `
    <app-month-header />

    @if (ledger.loadError()) {
      <p class="warn" role="status">{{ ledger.loadError() }}</p>
    }
    @if (sync.ops().length) {
      <p class="note" role="status">{{ sync.ops().length }} modifiche in attesa: i totali le includeranno dopo l'invio.</p>
    }

    <section class="totals" aria-label="Totali del mese">
      <div><span>Entrate</span><strong>{{ fmt(totals().income) }}</strong></div>
      <div><span>Uscite</span><strong>{{ fmt(totals().expense) }}</strong></div>
      <div><span>Accantonato</span><strong>{{ fmt(-totals().saving) }}</strong></div>
      <div><span>Netto</span><strong>{{ fmt(totals().net) }}</strong></div>
    </section>

    @if (unassigned().n) {
      <a class="unassigned" routerLink="/movimenti" [queryParams]="{ filtro: 'da-assegnare' }">
        <span>Da assegnare · {{ unassigned().n }} movimenti</span>
        <strong>{{ fmt(unassigned().cents) }}</strong>
      </a>
    }

    @for (g of groups(); track g.title) {
      <section>
        <h2>
          <span>{{ g.title }}</span><span>{{ fmt(g.total) }}</span>
        </h2>
        <ul>
          @for (r of g.rows; track r.name) {
            <li>
              <span>{{ r.name }}</span><span>{{ fmt(r.cents) }}</span>
            </li>
          }
        </ul>
      </section>
    } @empty {
      @if (!unassigned().n) {
        <p class="note">Nessun movimento in questo mese.</p>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 16px;
    }
    .totals {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .totals div {
      display: grid;
      gap: 2px;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    .totals span {
      font: var(--mat-sys-label-medium);
      color: var(--mat-sys-on-surface-variant);
    }
    .totals strong {
      font: var(--mat-sys-title-medium);
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
      display: flex;
      justify-content: space-between;
      min-height: 40px;
      align-items: center;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .note {
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class Month {
  protected readonly ledger = inject(Ledger);
  protected readonly sync = inject(Sync);
  protected readonly fmt = formatCents;

  private readonly rows = computed(() => {
    const cats = this.ledger.categoryById();
    return this.ledger.actuals().map((a) => {
      const cat = a.category_id ? cats.get(a.category_id) : undefined;
      const kind = cat?.kind ?? (a.inflow ? 'income' : 'expense');
      const cents = a.actual_cents ?? 0;
      const unassigned = !cat || (kind !== 'income' && !a.bucket_id);
      return { cat, kind, cents, n: a.n ?? 0, bucketId: a.bucket_id, unassigned };
    });
  });

  protected readonly totals = computed(() => {
    const sum = (kind: string) => this.rows().filter((r) => r.kind === kind).reduce((s, r) => s + r.cents, 0);
    const [income, expense, saving] = [sum('income'), sum('expense'), sum('saving')];
    return { income, expense, saving, net: income + expense + saving };
  });

  protected readonly unassigned = computed(() =>
    this.rows()
      .filter((r) => r.unassigned)
      .reduce((acc, r) => ({ n: acc.n + r.n, cents: acc.cents + r.cents }), { n: 0, cents: 0 }),
  );

  /** Righe per secchio (uscite e risparmi) più il gruppo delle entrate. */
  protected readonly groups = computed<Group[]>(() => {
    const group = (title: string, keep: (r: ReturnType<typeof this.rows>[number]) => boolean): Group => {
      const byName = new Map<string, number>();
      for (const r of this.rows().filter((r) => !r.unassigned && keep(r))) {
        byName.set(r.cat!.name, (byName.get(r.cat!.name) ?? 0) + r.cents);
      }
      const rows = [...byName].map(([name, cents]) => ({ name, cents })).sort((a, b) => a.cents - b.cents);
      return { title, rows, total: rows.reduce((s, r) => s + r.cents, 0) };
    };
    const buckets = this.ledger.buckets().map((b) => group(b.name, (r) => r.bucketId === b.id));
    return [...buckets, group('Entrate', (r) => r.kind === 'income')].filter((g) => g.rows.length);
  });
}
