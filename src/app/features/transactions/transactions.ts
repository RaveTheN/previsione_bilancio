import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { Ledger } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { MonthHeader, SwipeMonth } from '../../shared/month-header';
import { QuickAddLauncher } from '../quick-add/quick-add';

@Component({
  selector: 'app-transactions',
  imports: [MonthHeader],
  hostDirectives: [SwipeMonth],
  template: `
    <app-month-header />

    <label class="filter">
      <input type="checkbox" [checked]="onlyUnassigned()" (change)="toggleFilter()" />
      Solo da assegnare
    </label>

    @if (ledger.loadError()) {
      <p class="warn" role="status">{{ ledger.loadError() }}</p>
    }

    @for (day of days(); track day.date) {
      <section>
        <h2>{{ day.label }}</h2>
        <ul>
          @for (t of day.items; track t.id) {
            <li>
              @if (t.transfer_group_id) {
                <div class="row">
                  <span class="text">
                    <span class="title">{{ t.category_id ? 'Accantonamento' : 'Trasferimento' }}</span>
                    <span class="sub">{{ ledger.accountById().get(t.account_id)?.name }}</span>
                  </span>
                  <span class="amount">{{ fmt(t.amount_cents) }}</span>
                </div>
              } @else {
                <div class="swipe">
                  <button type="button" class="row" (click)="launcher.open(t)">
                    <span class="text">
                      <span class="title">{{ title(t) }}</span>
                      <span class="sub" [class.todo]="isUnassigned(t)">{{ subtitle(t) }}</span>
                    </span>
                    <span class="amount" [class.in]="t.amount_cents > 0">{{ fmt(t.amount_cents) }}</span>
                  </button>
                  <button type="button" class="delete" (click)="launcher.remove(t)">Elimina</button>
                </div>
              }
            </li>
          }
        </ul>
      </section>
    } @empty {
      <p class="note">{{ onlyUnassigned() ? 'Niente da assegnare in questo mese.' : 'Nessun movimento in questo mese.' }}</p>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 12px;
    }
    .filter {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
    }
    .filter input {
      width: 22px;
      height: 22px;
    }
    h2 {
      margin: 8px 0 4px;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .swipe {
      display: flex;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
    }
    .swipe::-webkit-scrollbar {
      display: none;
    }
    .row {
      flex: 0 0 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      min-height: 56px;
      padding: 6px 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      scroll-snap-align: start;
      cursor: pointer;
    }
    .text {
      display: grid;
      min-width: 0;
    }
    .title,
    .sub {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .sub.todo {
      color: var(--mat-sys-tertiary);
    }
    .amount {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .amount.in {
      color: var(--mat-sys-primary);
    }
    .delete {
      flex: 0 0 96px;
      border: 0;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font: var(--mat-sys-label-large);
      scroll-snap-align: end;
      cursor: pointer;
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .note {
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class Transactions {
  protected readonly ledger = inject(Ledger);
  protected readonly launcher = inject(QuickAddLauncher);
  private readonly sync = inject(Sync);
  private readonly router = inject(Router);
  protected readonly fmt = formatCents;

  protected readonly onlyUnassigned = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((p) => p.get('filtro') === 'da-assegnare')),
    { initialValue: false },
  );

  private readonly pendingIds = computed(
    () => new Set(this.sync.ops().flatMap((op) => (op.kind === 'upsert' ? [op.row['id']] : []))),
  );

  protected readonly days = computed(() => {
    const byDay = new Map<string, Transaction[]>();
    for (const t of this.ledger.transactions()) {
      if (this.onlyUnassigned() && !this.isUnassigned(t)) continue;
      byDay.set(t.booking_date, [...(byDay.get(t.booking_date) ?? []), t]);
    }
    return [...byDay].map(([date, items]) => ({
      date,
      items,
      label: new Date(date + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }),
    }));
  });

  protected isUnassigned(t: Transaction): boolean {
    if (t.transfer_group_id) return false;
    const cat = t.category_id ? this.ledger.categoryById().get(t.category_id) : undefined;
    return !cat || (cat.kind !== 'income' && !t.bucket_id);
  }

  protected title(t: Transaction): string {
    return t.merchant_raw ?? t.note ?? this.ledger.categoryById().get(t.category_id ?? '')?.name ?? 'Movimento';
  }

  protected subtitle(t: Transaction): string {
    const cat = this.ledger.categoryById().get(t.category_id ?? '');
    const bucket = this.ledger.bucketById().get(t.bucket_id ?? '');
    const tags = (t.transaction_tags ?? []).map((x) => this.ledger.tagById().get(x.tag_id)?.name).filter(Boolean);
    const parts = [
      this.isUnassigned(t) ? (cat ? `${cat.name} · secchio da assegnare` : 'Da assegnare') : cat?.name,
      bucket?.name,
      ...tags,
      this.pendingIds().has(t.id) ? 'in attesa di invio' : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  protected toggleFilter(): void {
    void this.router.navigate([], { queryParams: { filtro: this.onlyUnassigned() ? null : 'da-assegnare' } });
  }
}
