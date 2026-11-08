import { Component, computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatSnackBar } from '@angular/material/snack-bar';
import { defaultDate, lastDay, Ledger, monthLabel, shiftMonth, todayIso } from '../../core/ledger';
import { centsToInput, parseAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { PendingOp } from '../../core/queue';
import { errorText, isGenericOperation, Merchant, MonthLine, supabase, Transaction } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { TransferSheet } from '../transfer/transfer';

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
  const { id, account_id, line_id, merchant_id, amount_cents, booking_date, occurred_at, note } = t;
  return { id, account_id, line_id, merchant_id, amount_cents, booking_date, occurred_at, note };
}

function findMerchant<T extends Pick<Merchant, 'name'>>(merchants: T[], name: string): T | undefined {
  return merchants.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());
}

/**
 * Dove va il nome scritto nel campo Esercente. Un movimento senza nome della banca si collega
 * subito a un esercente già in Rubrica, anche offline; il resto si fa dopo l'invio (pendingName).
 */
export function merchantChoice(
  tx: Pick<Transaction, 'merchant_id' | 'merchant_raw'> | undefined,
  name: string,
  initialName: string,
  merchants: Pick<Merchant, 'id' | 'name'>[],
): { merchantId: string | null; pendingName: string | null } {
  const typed = name.trim();
  if (!typed || typed === initialName) return { merchantId: null, pendingName: null };
  const known = !tx?.merchant_id && !tx?.merchant_raw ? findMerchant(merchants, typed) : undefined;
  return { merchantId: known?.id ?? null, pendingName: known ? null : typed };
}

type LineChoice = Pick<MonthLine, 'id' | 'name' | 'bucket_id' | 'sort_order'>;
type TwinCandidate = Pick<Transaction, 'source' | 'account_id' | 'amount_cents' | 'booking_date' | 'merchant_raw'>;

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

      <div class="date">
        <label>Data <input type="date" name="date" required [ngModel]="date()" (ngModelChange)="setDate($event)" /></label>
        <button mat-stroked-button type="button" (click)="goToPreviousMonth()">← {{ previousMonthLabel() }}</button>
      </div>

      @if (hasMerchant) {
        <label class="merchant">
          Esercente
          <input name="merchant" list="elenco-esercenti" autocomplete="off" placeholder="Il nome che vuoi tu" [ngModel]="merchantName" (ngModelChange)="setMerchant($event)" />
          @if (tx?.merchant_raw) {
            <span class="hint">Dalla banca: {{ tx?.merchant_raw }}</span>
          }
        </label>
        <datalist id="elenco-esercenti">
          @for (m of ledger.merchants(); track m.id) {
            <option [value]="m.name"></option>
          }
        </datalist>
      }

      <p class="hint">Righe di {{ lineMonthLabel() }}</p>
      <!-- Le righe del mese del movimento: anche un'entrata può andare su una riga di spesa, come un rimborso. -->
      @for (g of lineGroups(); track g.title) {
        <div class="chips" role="group" [attr.aria-label]="g.title">
          <span class="group">{{ g.title }}</span>
          @for (l of g.lines; track l.id) {
            <button type="button" [class.on]="line()?.id === l.id" [attr.aria-pressed]="line()?.id === l.id" (click)="pickLine(l)">
              {{ l.name }}
            </button>
          }
        </div>
      } @empty {
        <p class="hint">{{ linesLoading() ? 'Carico le righe del mese…' : online() ? 'Nessuna riga in questo mese: creane una qui sotto.' : 'Sei offline: per ora il movimento resta da assegnare.' }}</p>
      }
      @if (missingLine(); as name) {
        <p class="hint" role="status">«{{ name }}» non c'è in {{ lineMonthLabel() }}: il movimento resterà da assegnare.</p>
      }
      <div class="chips">
        <button type="button" [attr.aria-expanded]="creating()" (click)="creating.set(!creating())">+ Nuova riga</button>
      </div>

      @if (creating()) {
        <div class="new-line">
          <label>
            Nome della riga
            <!-- Invio crea la riga, non salva il movimento. -->
            <input
              name="newLine"
              autocomplete="off"
              placeholder="Es. Abbonamento Claude"
              [(ngModel)]="newLineName"
              (keydown.enter)="$event.preventDefault(); createLine()"
            />
          </label>
          <label>
            Secchio
            <select name="newBucket" [(ngModel)]="newLineBucket">
              @for (b of ledger.buckets(); track b.id) {
                <option [value]="b.id">{{ b.name }}</option>
              }
              <option value="">Entrate</option>
            </select>
          </label>
          @if (!online()) {
            <span class="hint">Per creare una riga serve la connessione.</span>
          }
          <div class="actions">
            <button mat-stroked-button type="button" [disabled]="!online() || !newLineName.trim() || creatingBusy()" (click)="createLine()">
              Crea in {{ lineMonthLabel() }} e scegli
            </button>
          </div>
        </div>
      }

      <details [open]="!!tx || !!draft">
        <summary>Altro</summary>
        <label>
          Conto
          <select name="account" [(ngModel)]="accountId">
            @for (a of activeAccounts(); track a.id) {
              <option [value]="a.id">{{ a.name }}</option>
            }
          </select>
        </label>
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
        <button mat-flat-button type="submit" [disabled]="!amountCents() || !accountId || !date() || creatingBusy()">Salva</button>
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
    .chips .group {
      flex-basis: 100%;
      font: var(--mat-sys-label-medium);
      color: var(--mat-sys-on-surface-variant);
    }
    .new-line {
      display: grid;
      gap: 12px;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    .date {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 8px;
    }
    .date button {
      min-height: 44px;
    }
    .date label,
    .new-line label,
    details label,
    .merchant {
      display: grid;
      gap: 4px;
      margin-top: 12px;
      font: var(--mat-sys-label-large);
    }
    .date label,
    .merchant,
    .new-line label {
      margin-top: 0;
    }
    .hint {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
      overflow-wrap: anywhere;
    }
    .date input,
    .merchant input,
    .new-line input,
    .new-line select,
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
  private readonly ref = inject(MatBottomSheetRef<QuickAdd, Saved>);
  private readonly data = inject<{ tx?: Transaction; draft?: Draft }>(MAT_BOTTOM_SHEET_DATA);
  protected readonly tx = this.data?.tx;
  protected readonly draft = this.data?.draft;

  protected readonly income = signal(false);
  protected readonly amountText = signal('');
  protected readonly error = signal('');
  protected accountId = '';
  // Un desiderio comprato è di oggi; il resto parte dal mese che stai guardando.
  protected readonly date = signal(this.draft ? todayIso() : defaultDate(this.ledger.month()));
  protected note = '';
  protected tagsText = '';
  /** Nome scelto per l'esercente del movimento; si salva dopo l'invio (serve la connessione). */
  protected readonly hasMerchant = !!this.tx?.merchant_id || !isGenericOperation(this.tx?.merchant_raw ?? null);
  protected merchantName = this.ledger.merchantById().get(this.tx?.merchant_id ?? '')?.name ?? '';
  private readonly initialMerchantName = this.merchantName;

  protected readonly amountCents = computed(() => parseAmount(this.amountText()));
  protected readonly activeAccounts = computed(() => this.ledger.accounts().filter((a) => !a.archived));

  /** Le righe del mese del movimento: quelle già caricate, o lette apposta se è un altro mese. */
  private readonly lineMonth = computed(() => (this.date() || todayIso()).slice(0, 7) + '-01');
  private readonly otherMonth = signal<{ month: string; lines: LineChoice[]; rows: TwinCandidate[] } | null>(null);
  /** I dati letti apposta, se il movimento è in un mese diverso da quello caricato. */
  private readonly other = computed(() => {
    const o = this.otherMonth();
    return this.lineMonth() !== this.ledger.month() && o?.month === this.lineMonth() ? o : null;
  });
  protected readonly lines = computed<LineChoice[]>(() => (this.lineMonth() === this.ledger.month() ? this.ledger.lines() : (this.other()?.lines ?? [])));
  protected readonly linesLoading = computed(() => this.lineMonth() !== this.ledger.month() && !this.other());
  protected readonly previousMonthLabel = computed(() => monthLabel(shiftMonth(this.lineMonth(), -1)));
  protected readonly lineMonthLabel = computed(() => monthLabel(this.lineMonth()));

  /** La riga scelta; cambiando mese si ritrova per nome, come fa il database. */
  private readonly picked = signal<LineChoice | null>(null);
  protected readonly line = computed(() => {
    const p = this.picked();
    if (!p) return null;
    return this.lines().find((l) => l.id === p.id) ?? this.lines().find((l) => l.name.toLowerCase() === p.name.toLowerCase()) ?? null;
  });

  /** Un gruppo per secchio, più le entrate: prima quelle per un'entrata, in fondo per una spesa. */
  protected readonly lineGroups = computed(() => {
    const group = (title: string, bucketId: string | null) => ({ title, bucketId, lines: this.lines().filter((l) => l.bucket_id === bucketId) });
    const buckets = this.ledger.buckets().map((b) => group(b.name, b.id));
    // Dalla wishlist: prima il secchio del desiderio.
    buckets.sort((a, b) => Number(b.bucketId === this.draft?.bucketId) - Number(a.bucketId === this.draft?.bucketId));
    const income = group('Entrate', null);
    return (this.income() ? [income, ...buckets] : [...buckets, income]).filter((g) => g.lines.length);
  });

  /** Nuova riga creata da qui: solo online, come nella pagina Mese. */
  protected readonly online = onlineSignal();
  protected readonly creating = signal(false);
  protected readonly creatingBusy = signal(false);
  /** La riga creata da questa finestra, e il mese in cui si trova ora. */
  private created: { id: string; month: string } | null = null;
  /** Uno spostamento alla volta: due tocchi veloci su "mese prima" non si scavalcano. */
  private moves = Promise.resolve();
  /** La riga scelta non esiste nel mese della data: va detto, altrimenti la scelta sparisce in silenzio. */
  protected readonly missingLine = computed(() => (this.picked() && !this.line() && !this.linesLoading() && !this.creatingBusy() ? this.picked()!.name : null));
  protected newLineName = '';
  protected newLineBucket = this.draft?.bucketId ?? '';

  constructor() {
    const t = this.tx;
    if (t) {
      this.income.set(t.amount_cents > 0);
      this.amountText.set((Math.abs(t.amount_cents) / 100).toFixed(2).replace('.', ','));
      this.accountId = t.account_id;
      this.date.set(t.booking_date);
      this.note = t.note ?? '';
      this.tagsText = (t.transaction_tags ?? [])
        .map((x) => this.ledger.tagById().get(x.tag_id)?.name)
        .filter(Boolean)
        .join(', ');
    } else {
      const last = String(readMap(ACCOUNT_KEY)['id'] ?? '');
      const accounts = this.activeAccounts();
      this.accountId = accounts.find((a) => a.id === last)?.id ?? accounts.find((a) => a.role === 'spendable')?.id ?? '';
      if (this.draft) {
        this.amountText.set(centsToInput(this.draft.cents));
        this.note = this.draft.note;
      }
    }
    this.newLineBucket ||= this.ledger.buckets()[0]?.id ?? '';
    effect(() => {
      const month = this.lineMonth();
      if (month !== this.ledger.month()) untracked(() => void this.loadLines(month));
    });
    // La riga del movimento può non essere nel mese caricato: si ritrova appena arrivano le righe.
    if (t?.line_id) {
      const id = t.line_id;
      effect(() => {
        const found = this.lines().find((l) => l.id === id);
        if (found && !untracked(this.picked)) this.picked.set(found);
      });
    }
  }

  private async loadLines(month: string): Promise<void> {
    // Un mese ancora vuoto prende le righe del precedente, come quando lo apri.
    if (this.online()) await supabase.rpc('ensure_month_lines', { p_month: month });
    const [lines, rows] = await Promise.all([
      supabase.from('budget_lines').select('id, name, bucket_id, sort_order').eq('month', month).order('sort_order').order('name'),
      // Per l'avviso "sembra già registrata", che deve valere anche nei mesi non aperti.
      supabase.from('transactions').select('source, account_id, amount_cents, booking_date, merchant_raw').eq('month', month),
    ]);
    // Si scrive anche se vuoto: offline il caricamento deve finire comunque.
    this.otherMonth.set({ month, lines: lines.data ?? [], rows: rows.data ?? [] });
  }

  /** Ultimo giorno del mese prima: premuto di nuovo, torna ancora indietro. */
  protected goToPreviousMonth(): void {
    this.setDate(lastDay(shiftMonth(this.lineMonth(), -1)));
  }

  protected setDate(value: string): void {
    this.date.set(value);
    if (value) this.moves = this.moves.then(() => this.moveCreatedLine());
  }

  /** Una riga appena creata da qui segue la data: non ha movimenti, quindi spostarla è sicuro. */
  private async moveCreatedLine(): Promise<void> {
    const month = this.lineMonth();
    const line = this.created;
    if (!line || line.month === month || this.picked()?.id !== line.id) return;
    this.creatingBusy.set(true);
    try {
      // Prima la copia: con la riga già dentro, un mese vuoto non prenderebbe più le altre.
      await supabase.rpc('ensure_month_lines', { p_month: month });
      const moved = await supabase.from('budget_lines').update({ month }).eq('id', line.id);
      if (moved.error?.code === '23505') {
        // In quel mese una riga con questo nome c'è già: la scelta passa a quella.
        await supabase.from('budget_lines').delete().eq('id', line.id);
        this.created = null;
      } else if (moved.error) {
        this.error.set('Riga non spostata: ' + errorText(moved));
        return;
      } else {
        line.month = month;
      }
      await this.ledger.load();
      if (month !== this.ledger.month()) await this.loadLines(month);
    } finally {
      this.creatingBusy.set(false);
    }
  }

  protected setIncome(value: boolean): void {
    this.income.set(value);
  }

  /** Su un movimento nuovo propone la riga della regola: per nome, così vale nel mese della data. */
  protected setMerchant(name: string): void {
    this.merchantName = name;
    const rule = this.tx || this.picked() ? null : findMerchant(this.ledger.merchants(), name)?.default_line_name;
    if (rule) this.picked.set({ id: '', name: rule, bucket_id: null, sort_order: 0 });
  }

  protected pickLine(l: LineChoice): void {
    this.picked.set(this.line()?.id === l.id ? null : l);
  }

  /** Crea la riga in fondo al mese del movimento e la sceglie. */
  protected async createLine(): Promise<void> {
    const name = this.newLineName.trim();
    if (!name || !this.online() || this.creatingBusy()) return;
    this.creatingBusy.set(true);
    const month = this.lineMonth();
    try {
      const order = Math.max(0, ...this.lines().map((l) => l.sort_order)) + 1;
      const res = await supabase
        .from('budget_lines')
        .insert({ month, name, bucket_id: this.newLineBucket || null, amount_cents: 0, sort_order: order })
        .select('id, name, bucket_id, sort_order')
        .single();
      if (res.error) {
        this.error.set(res.error.code === '23505' ? 'Esiste già una riga con questo nome nel mese' : 'Riga non creata: ' + errorText(res));
        return;
      }
      await (month === this.ledger.month() ? this.ledger.load() : this.loadLines(month));
      this.error.set('');
      this.newLineName = '';
      this.creating.set(false);
      this.picked.set(res.data);
      this.created = { id: res.data.id, month };
    } finally {
      this.creatingBusy.set(false);
    }
    // La data può essere cambiata mentre la riga veniva creata.
    this.moves = this.moves.then(() => this.moveCreatedLine());
  }

  protected save(): void {
    const cents = this.amountCents();
    if (!cents || !this.accountId || !this.date()) return;
    const signed = this.income() ? cents : -cents;
    if (!this.tx) {
      // Una spesa già arrivata da una notifica non va registrata di nuovo senza volerlo.
      const candidates: TwinCandidate[] = this.other()?.rows ?? this.ledger.transactions();
      const twin = candidates
        .find(
          (t) =>
            t.source !== 'manual' &&
            t.account_id === this.accountId &&
            t.amount_cents === signed &&
            Math.abs(Date.parse(t.booking_date) - Date.parse(this.date())) <= 86_400_000,
        );
      if (twin && !confirm(`Sembra già registrata: ${twin.merchant_raw ?? 'movimento'} del ${twin.booking_date}. Salvare comunque?`)) {
        return;
      }
    }
    const id = this.tx?.id ?? crypto.randomUUID();
    const date = this.date();
    const occurredAt =
      this.tx?.booking_date === date
        ? this.tx.occurred_at
        : date === todayIso()
          ? new Date().toISOString()
          : new Date(date + 'T12:00:00').toISOString();
    const merchant = merchantChoice(this.tx, this.merchantName, this.initialMerchantName, this.ledger.merchants());
    const row = {
      id,
      account_id: this.accountId,
      line_id: this.line()?.id ?? null,
      amount_cents: signed,
      booking_date: date,
      occurred_at: occurredAt,
      note: this.note.trim() || null,
      ...(merchant.merchantId ? { merchant_id: merchant.merchantId } : {}),
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
    // Solo un movimento ancora da assegnare insegna la regola all'esercente:
    // correggerne uno già assegnato resta un'eccezione.
    const propagate = !!this.tx && this.hasMerchant && !this.tx.line_id && !!row.line_id;
    const otherMonth = this.lineMonth() !== this.ledger.month() ? this.lineMonth() : undefined;
    this.ref.dismiss({ id, undo, propagate, merchantName: merchant.pendingName, otherMonth });
  }

  protected remove(): void {
    if (!this.tx) return;
    try {
      this.sync.add({ table: 'transactions', kind: 'delete', match: { id: this.tx.id } });
    } catch (e) {
      this.error.set('Non eliminato: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    this.ref.dismiss({ id: this.tx.id, undo: restoreOps(this.tx), propagate: false, merchantName: null });
  }
}

/** Valori iniziali di un movimento nuovo, es. un desiderio appena comprato. */
export interface Draft {
  cents: number;
  note: string;
  bucketId: string | null;
}

interface Saved {
  id: string;
  undo: PendingOp[];
  /** Dopo l'invio, assegna come questo gli altri movimenti dello stesso esercente. */
  propagate: boolean;
  /** Nome dell'esercente scritto nel movimento, se cambiato. */
  merchantName: string | null;
  /** Salvato in un mese diverso da quello aperto: non si vede nella lista, quindi lo si dice. */
  otherMonth?: string;
}

/** Risultato di assign_like: serve anche così com'è per undo_assign_like. */
interface AssignResult {
  name: string;
  rows: unknown[];
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

  open(tx?: Transaction, draft?: Draft, onSaved?: (id: string) => void): void {
    this.sheet
      .open<QuickAdd, { tx?: Transaction; draft?: Draft }, Saved>(QuickAdd, {
        data: { tx, draft },
        autoFocus: tx || draft ? 'dialog' : 'input[name=amount]',
      })
      .afterDismissed()
      .subscribe((saved) => {
        if (!saved) return;
        this.confirm((tx ? 'Salvato' : 'Aggiunto') + (saved.otherMonth ? ` in ${monthLabel(saved.otherMonth)}` : ''), saved.undo);
        if (saved.propagate || saved.merchantName) void this.afterSave(tx, saved);
        onSaved?.(saved.id);
      });
  }

  /** Dopo l'invio del movimento: nome dell'esercente, poi regola e movimenti simili. */
  private async afterSave(tx: Transaction | undefined, saved: Saved): Promise<void> {
    await this.sync.flush();
    // shortcut: offline si salta; nome e regola si rifanno riaprendo il movimento quando torni online.
    if (this.sync.ops().length) {
      this.snackBar.open('Offline: esercente e movimenti simili non aggiornati', 'OK', { duration: 5000 });
      return;
    }
    if (saved.merchantName && !(await this.nameMerchant(tx, saved.id, saved.merchantName))) return;
    if (saved.propagate) await this.assignLike(saved.id);
    else void this.ledger.load();
  }

  /** Rinomina l'esercente del movimento, oppure lo crea (o lo trova per nome) e collega il nome grezzo. */
  private async nameMerchant(tx: Transaction | undefined, id: string, name: string): Promise<boolean> {
    if (tx?.merchant_id) {
      const res = await supabase.from('merchants').update({ name }).eq('id', tx.merchant_id);
      if (res.error) {
        this.snackBar.open(res.error.code === '23505' ? 'Esiste già un esercente con questo nome' : 'Nome non salvato: ' + errorText(res), 'OK');
      }
      return !res.error;
    }
    // Inserito a mano: non c'è un nome della banca da collegare, l'esercente nasce da qui.
    if (!tx?.merchant_raw) {
      const created = await supabase.from('merchants').insert({ name }).select('id').single();
      const res = created.error ? created : await supabase.from('transactions').update({ merchant_id: created.data.id }).eq('id', id);
      if (res.error) this.snackBar.open('Esercente non salvato: ' + errorText(res), 'OK');
      return !res.error;
    }
    const key = await supabase.rpc('merchant_key', { p_raw: tx.merchant_raw });
    const res = key.error ? key : await supabase.rpc('link_alias', { p_pattern: key.data ?? '', p_contains: false, p_name: name });
    if (res.error) {
      this.snackBar.open('Esercente non salvato: ' + errorText(res), 'OK');
      return false;
    }
    return true;
  }

  /** "Assegnati anche altri N movimenti di X · Annulla". Annulla tocca solo gli altri, non questo. */
  private async assignLike(id: string): Promise<void> {
    const res = await supabase.rpc('assign_like', { p_transaction_id: id });
    if (res.error) {
      this.snackBar.open('Regola dell\'esercente non salvata: ' + errorText(res), 'OK');
      return;
    }
    const result = res.data as AssignResult | null;
    void this.ledger.load();
    const n = result?.rows.length ?? 0;
    if (!result || !n) return;
    this.snackBar
      .open(`Assegnat${n === 1 ? 'o' : 'i'} anche ${n === 1 ? 'un altro movimento' : `altri ${n} movimenti`} di ${result.name}`, 'Annulla', {
        duration: 8000,
      })
      .onAction()
      .subscribe(async () => {
        const undo = await supabase.rpc('undo_assign_like', { p_result: result as never });
        if (undo.error) this.snackBar.open('Annullamento non riuscito: ' + errorText(undo), 'OK');
        void this.ledger.load();
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
