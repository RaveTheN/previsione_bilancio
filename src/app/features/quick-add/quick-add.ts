import { Component, computed, inject, Injectable, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Ledger, todayIso } from '../../core/ledger';
import { parseAmount } from '../../core/money';
import { PendingOp } from '../../core/queue';
import { Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { TransferSheet } from '../transfer/transfer';

const USAGE_KEY = 'bilancio.uso-categorie';
const BUCKET_KEY = 'bilancio.secchio-per-categoria';
const ACCOUNT_KEY = 'bilancio.ultimo-conto';

function readMap(key: string): Record<string, string | number> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

/** Campi modificabili dall'app: il resto (fonte, causale importata…) non si tocca. */
function editable(t: Transaction): Record<string, unknown> {
  const { id, account_id, category_id, bucket_id, amount_cents, booking_date, occurred_at, note } = t;
  return { id, account_id, category_id, bucket_id, amount_cents, booking_date, occurred_at, note };
}

@Component({
  selector: 'app-quick-add',
  imports: [FormsModule, MatButtonModule],
  template: `
    <form (ngSubmit)="save()">
      <div class="segmented" role="group" aria-label="Tipo di movimento">
        <button type="button" [class.on]="!income()" [attr.aria-pressed]="!income()" (click)="setIncome(false)">
          Uscita
        </button>
        <button type="button" [class.on]="income()" [attr.aria-pressed]="income()" (click)="setIncome(true)">
          Entrata
        </button>
      </div>

      <label class="amount">
        <span class="visually-hidden">Importo in euro</span>
        <input
          name="amount"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0,00"
          [ngModel]="amountText()"
          (ngModelChange)="amountText.set($event)"
        />
        <span aria-hidden="true">€</span>
      </label>

      <div class="chips" role="group" aria-label="Categoria">
        @for (c of shownCategories(); track c.id) {
          <button type="button" [class.on]="categoryId() === c.id" [attr.aria-pressed]="categoryId() === c.id" (click)="pickCategory(c.id)">
            {{ c.name }}
          </button>
        }
        @if (!showAll() && hiddenCount() > 0) {
          <button type="button" (click)="showAll.set(true)">Altre ({{ hiddenCount() }})</button>
        }
      </div>

      @if (!income()) {
        <div class="segmented" role="group" aria-label="Secchio">
          @for (b of ledger.buckets(); track b.id) {
            <button type="button" [class.on]="bucketId() === b.id" [attr.aria-pressed]="bucketId() === b.id" (click)="toggleBucket(b.id)">
              {{ b.name }}
            </button>
          }
        </div>
      }

      <details [open]="!!tx">
        <summary>Altro</summary>
        <label>
          Conto
          <select name="account" [(ngModel)]="accountId">
            @for (a of activeAccounts(); track a.id) {
              <option [value]="a.id">{{ a.name }}</option>
            }
          </select>
        </label>
        <label>Data <input type="date" name="date" required [(ngModel)]="date" /></label>
        <label>Nota <input name="note" autocomplete="off" [(ngModel)]="note" /></label>
        <label>
          Tag (separati da virgola)
          <input name="tags" list="elenco-tag" autocomplete="off" [(ngModel)]="tagsText" />
        </label>
        <datalist id="elenco-tag">
          @for (t of ledger.tags(); track t.id) {
            <option [value]="t.name"></option>
          }
        </datalist>
      </details>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <div class="actions">
        @if (tx) {
          <button mat-button type="button" (click)="remove()">Elimina</button>
        }
        <button mat-flat-button type="submit" [disabled]="!amountCents() || !accountId">Salva</button>
      </div>
    </form>
  `,
  styles: `
    form {
      display: grid;
      gap: 16px;
      padding: 8px 4px calc(8px + env(safe-area-inset-bottom));
    }
    .segmented {
      display: flex;
      gap: 8px;
    }
    .segmented button,
    .chips button {
      min-height: 44px;
      padding: 0 14px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 22px;
      background: none;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }
    .segmented button {
      flex: 1;
    }
    .on {
      border-color: var(--mat-sys-primary) !important;
      background: var(--mat-sys-primary-container) !important;
      color: var(--mat-sys-on-primary-container) !important;
    }
    .amount {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font: var(--mat-sys-display-small);
    }
    .amount input {
      width: 100%;
      min-width: 0;
      border: 0;
      border-bottom: 2px solid var(--mat-sys-primary);
      background: none;
      color: inherit;
      font: inherit;
      outline: none;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    details label {
      display: grid;
      gap: 4px;
      margin-top: 12px;
      font: var(--mat-sys-label-large);
    }
    details input,
    details select {
      min-height: 44px;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    summary {
      min-height: 44px;
      display: flex;
      align-items: center;
      cursor: pointer;
      font: var(--mat-sys-label-large);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .actions button {
      min-height: 48px;
    }
    .error {
      margin: 0;
      color: var(--mat-sys-error);
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
  `,
})
export class QuickAdd {
  protected readonly ledger = inject(Ledger);
  private readonly sync = inject(Sync);
  private readonly ref = inject(MatBottomSheetRef<QuickAdd, PendingOp[]>);
  protected readonly tx = inject<{ tx?: Transaction }>(MAT_BOTTOM_SHEET_DATA)?.tx;

  protected readonly income = signal(false);
  protected readonly amountText = signal('');
  protected readonly categoryId = signal<string | null>(null);
  protected readonly bucketId = signal<string | null>(null);
  protected readonly showAll = signal(false);
  protected readonly error = signal('');
  protected accountId = '';
  protected date = todayIso();
  protected note = '';
  protected tagsText = '';

  protected readonly amountCents = computed(() => parseAmount(this.amountText()));
  protected readonly activeAccounts = computed(() => this.ledger.accounts().filter((a) => !a.archived));

  private readonly candidates = computed(() => {
    const usage = readMap(USAGE_KEY);
    const kinds = this.income() ? ['income'] : ['expense', 'saving'];
    return this.ledger
      .categories()
      .filter((c) => kinds.includes(c.kind) && !c.archived)
      .sort((a, b) => (Number(usage[b.id] ?? 0) - Number(usage[a.id] ?? 0)) || a.sort_order - b.sort_order);
  });
  protected readonly shownCategories = computed(() =>
    this.showAll() ? this.candidates() : this.candidates().slice(0, 8),
  );
  protected readonly hiddenCount = computed(() => this.candidates().length - this.shownCategories().length);

  constructor() {
    const t = this.tx;
    if (t) {
      this.income.set(t.amount_cents > 0);
      this.amountText.set((Math.abs(t.amount_cents) / 100).toFixed(2).replace('.', ','));
      this.categoryId.set(t.category_id);
      this.bucketId.set(t.bucket_id);
      this.accountId = t.account_id;
      this.date = t.booking_date;
      this.note = t.note ?? '';
      this.tagsText = (t.transaction_tags ?? [])
        .map((x) => this.ledger.tagById().get(x.tag_id)?.name)
        .filter(Boolean)
        .join(', ');
    } else {
      const last = String(readMap(ACCOUNT_KEY)['id'] ?? '');
      const accounts = this.activeAccounts();
      this.accountId = accounts.find((a) => a.id === last)?.id ?? accounts.find((a) => a.role === 'spendable')?.id ?? '';
    }
  }

  protected setIncome(value: boolean): void {
    if (value === this.income()) return;
    this.income.set(value);
    this.categoryId.set(null);
    this.bucketId.set(null);
  }

  protected pickCategory(id: string): void {
    this.categoryId.set(id);
    // Proposta, non regola: il secchio resta visibile e lo cambi con un tocco.
    if (!this.income()) this.bucketId.set((readMap(BUCKET_KEY)[id] as string | undefined) ?? this.bucketId());
  }

  protected toggleBucket(id: string): void {
    this.bucketId.set(this.bucketId() === id ? null : id);
  }

  protected save(): void {
    const cents = this.amountCents();
    if (!cents || !this.accountId) return;
    const id = this.tx?.id ?? crypto.randomUUID();
    const occurredAt =
      this.tx?.booking_date === this.date
        ? this.tx.occurred_at
        : this.date === todayIso()
          ? new Date().toISOString()
          : new Date(this.date + 'T12:00:00').toISOString();
    const row = {
      id,
      account_id: this.accountId,
      category_id: this.categoryId(),
      bucket_id: this.income() ? null : this.bucketId(),
      amount_cents: this.income() ? cents : -cents,
      booking_date: this.date,
      occurred_at: occurredAt,
      note: this.note.trim() || null,
    };

    const ops: PendingOp[] = [{ table: 'transactions', kind: 'upsert', row }];
    if (this.tx) ops.push({ table: 'transaction_tags', kind: 'delete', match: { transaction_id: id } });
    const existing = new Map(this.ledger.tags().map((t) => [t.name.toLowerCase(), t.id]));
    const names = [...new Set(this.tagsText.split(',').map((s) => s.trim()).filter(Boolean))];
    for (const name of names) {
      let tagId = existing.get(name.toLowerCase());
      if (!tagId) {
        tagId = crypto.randomUUID();
        existing.set(name.toLowerCase(), tagId);
        ops.push({ table: 'tags', kind: 'upsert', row: { id: tagId, name } });
      }
      ops.push({ table: 'transaction_tags', kind: 'upsert', row: { transaction_id: id, tag_id: tagId } });
    }

    try {
      this.sync.add(...ops);
    } catch (e) {
      this.error.set('Non salvato: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }

    const usage = readMap(USAGE_KEY);
    if (row.category_id) {
      usage[row.category_id] = Number(usage[row.category_id] ?? 0) + 1;
      localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
      if (row.bucket_id) {
        localStorage.setItem(BUCKET_KEY, JSON.stringify({ ...readMap(BUCKET_KEY), [row.category_id]: row.bucket_id }));
      }
    }
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ id: row.account_id }));

    const undo: PendingOp[] = this.tx
      ? [
          { table: 'transactions', kind: 'upsert', row: editable(this.tx) },
          { table: 'transaction_tags', kind: 'delete', match: { transaction_id: id } },
          ...(this.tx.transaction_tags ?? []).map(
            (x): PendingOp => ({ table: 'transaction_tags', kind: 'upsert', row: { transaction_id: id, tag_id: x.tag_id } }),
          ),
        ]
      : [{ table: 'transactions', kind: 'delete', match: { id } }];
    this.ref.dismiss(undo);
  }

  protected remove(): void {
    if (!this.tx) return;
    try {
      this.sync.add({ table: 'transactions', kind: 'delete', match: { id: this.tx.id } });
    } catch (e) {
      this.error.set('Non eliminato: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    this.ref.dismiss(restoreOps(this.tx));
  }
}

/** Operazioni per ricreare un movimento eliminato, tag compresi. */
export function restoreOps(t: Transaction): PendingOp[] {
  const { transaction_tags, month: _month, ...row } = t;
  return [
    { table: 'transactions', kind: 'upsert', row },
    ...(transaction_tags ?? []).map(
      (x): PendingOp => ({ table: 'transaction_tags', kind: 'upsert', row: { transaction_id: t.id, tag_id: x.tag_id } }),
    ),
  ];
}

@Injectable({ providedIn: 'root' })
export class QuickAddLauncher {
  private readonly sheet = inject(MatBottomSheet);
  private readonly snackBar = inject(MatSnackBar);
  private readonly sync = inject(Sync);
  private readonly ledger = inject(Ledger);

  open(tx?: Transaction): void {
    this.sheet
      .open<QuickAdd, { tx?: Transaction }, PendingOp[]>(QuickAdd, {
        data: { tx },
        autoFocus: tx ? 'dialog' : 'input[name=amount]',
      })
      .afterDismissed()
      .subscribe((undo) => {
        if (undo) this.confirm(tx ? 'Salvato' : 'Aggiunto', undo);
      });
  }

  openTransfer(): void {
    this.sheet
      .open<TransferSheet, void, string>(TransferSheet)
      .afterDismissed()
      .subscribe((group) => {
        if (group) this.confirm('Trasferito', [{ table: 'transactions', kind: 'delete', match: { transfer_group_id: group } }]);
      });
  }

  /** Un trasferimento si elimina con entrambe le righe (create con la stessa data, quindi nello stesso mese). */
  remove(t: Transaction): void {
    const group = t.transfer_group_id;
    const rows = group ? this.ledger.transactions().filter((x) => x.transfer_group_id === group) : [t];
    try {
      this.sync.add({ table: 'transactions', kind: 'delete', match: group ? { transfer_group_id: group } : { id: t.id } });
    } catch (e) {
      this.snackBar.open('Non eliminato: ' + (e instanceof Error ? e.message : String(e)), 'OK');
      return;
    }
    this.confirm('Eliminato', rows.flatMap(restoreOps));
  }

  /** "Salvato · Annulla": l'annullamento passa anch'esso dalla coda. */
  confirm(message: string, undo: PendingOp[]): void {
    this.snackBar
      .open(message, 'Annulla', { duration: 5000 })
      .onAction()
      .subscribe(() => this.sync.add(...undo));
  }
}
