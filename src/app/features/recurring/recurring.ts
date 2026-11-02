import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forecastToInput, inputToForecast } from '../../core/budget';
import { italianDate, reminderIcs, saveFile } from '../../core/files';
import { Ledger, todayIso } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, RecurringRule, supabase } from '../../core/supabase';
import { nextDue, yearlyCost } from './schedule';

/** Spese fisse: ognuna crea un movimento alla scadenza. Solo online. */
@Component({
  selector: 'app-recurring',
  imports: [FormsModule, MatButtonModule],
  template: `
    <h1>Ricorrenti</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: le ricorrenti si modificano solo con la connessione.</p>
    }

    <section class="card" aria-label="Costo delle spese ricorrenti">
      <span class="label">Spese ricorrenti attive</span>
      <strong>{{ fmt(totals().year / 12) }} al mese · {{ fmt(totals().year) }} all'anno</strong>
    </section>

    <p class="note">
      Il movimento si crea da solo, la notte del giorno di scadenza. Se arriva anche il pagamento reale, con lo stesso importo
      ed entro 3 giorni, diventano un movimento solo.
    </p>

    <fieldset [disabled]="!online()">
      <ul>
        @for (r of rules(); track r.id) {
          <li>
            <div class="line">
              <strong>{{ r.name }}</strong>
              <span class="num">{{ fmt(r.amount_cents) }}</span>
            </div>
            <span class="sub">{{ when(r) }}</span>
            <span class="sub">{{ assignment(r) }}</span>
            <span class="sub">{{ fmt(yearly(r) / 12) }} al mese · {{ fmt(yearly(r)) }} all'anno</span>
            @if (r.cancel_by) {
              <div class="line">
                <span class="warn">Disdire entro {{ date(r.cancel_by) }}</span>
                <button mat-button type="button" (click)="toCalendar(r)">Aggiungi al Calendario</button>
              </div>
            }
            <div class="actions">
              <button mat-stroked-button type="button" (click)="edit(r)">Modifica</button>
              <button mat-button type="button" (click)="remove(r)">Elimina</button>
            </div>
          </li>
        } @empty {
          <p class="note">Ancora nessuna.</p>
        }
      </ul>

      <form (ngSubmit)="save()">
        <h2>{{ editing() ? 'Modifica ricorrente' : 'Nuova ricorrente' }}</h2>
        <label>Nome <input name="name" autocomplete="off" placeholder="Es. Netflix" [(ngModel)]="name" /></label>
        <label>
          Categoria
          <select name="category" [ngModel]="categoryId()" (ngModelChange)="categoryId.set($event)">
            <option value="">Scegli</option>
            @for (c of categories(); track c.id) {
              <option [value]="c.id">{{ c.name }}</option>
            }
          </select>
        </label>
        @if (kind() !== 'income') {
          <label>
            Secchio
            <select name="bucket" [(ngModel)]="bucketId">
              <option value="">Scegli</option>
              @for (b of ledger.buckets(); track b.id) {
                <option [value]="b.id">{{ b.name }}</option>
              }
            </select>
          </label>
        }
        <label>Importo (€) <input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" [(ngModel)]="amountText" /></label>
        <label>
          Conto
          <select name="account" [ngModel]="accountId || defaultAccount()" (ngModelChange)="accountId = $event">
            @for (a of accounts(); track a.id) {
              <option [value]="a.id">{{ a.name }}</option>
            }
          </select>
        </label>
        <label>
          Frequenza
          <select name="frequency" [(ngModel)]="frequency">
            <option value="monthly">Ogni mese</option>
            <option value="yearly">Ogni anno</option>
          </select>
        </label>
        <label>Prima scadenza (dà il giorno, e per le annuali il mese) <input type="date" name="start" [(ngModel)]="startDate" /></label>
        <label>Ultima scadenza, se finisce <input type="date" name="end" [(ngModel)]="endDate" /></label>
        <label>Disdire entro, per il promemoria <input type="date" name="cancel" [(ngModel)]="cancelBy" /></label>
        <div class="actions">
          @if (editing()) {
            <button mat-button type="button" (click)="reset()">Annulla</button>
          }
          <button mat-flat-button type="submit">Salva</button>
        </div>
      </form>
    </fieldset>
  `,
  styles: `
    :host,
    fieldset {
      display: grid;
      gap: 16px;
    }
    fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-title-large);
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    .card {
      display: grid;
      gap: 4px;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    .label,
    .sub {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: grid;
      gap: 4px;
      padding: 10px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .num {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    button {
      min-height: 44px;
    }
    form,
    label {
      display: grid;
      gap: 6px;
    }
    form {
      gap: 12px;
    }
    label {
      font: var(--mat-sys-label-large);
    }
    input,
    select {
      min-width: 0;
      min-height: 44px;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    .note {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    .warn {
      color: var(--mat-sys-error);
    }
  `,
})
export class Recurring implements OnInit {
  protected readonly ledger = inject(Ledger);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly date = italianDate;
  protected readonly yearly = yearlyCost;
  protected readonly rules = signal<RecurringRule[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected readonly categoryId = signal('');
  protected name = '';
  protected bucketId = '';
  protected amountText = '';
  protected accountId = '';
  protected frequency = 'monthly';
  protected startDate = todayIso();
  protected endDate = '';
  protected cancelBy = '';

  protected readonly categories = computed(() => this.ledger.categories().filter((c) => !c.archived));
  protected readonly accounts = computed(() => this.ledger.accounts().filter((a) => !a.archived));
  /** I conti possono arrivare dopo l'apertura della pagina: il predefinito segue il caricamento. */
  protected readonly defaultAccount = computed(() => this.accounts().find((a) => a.role === 'spendable')?.id ?? '');
  protected readonly kind = computed(() => this.ledger.categoryById().get(this.categoryId())?.kind);

  /** Solo le spese ancora attive: quelle finite non costano più. */
  protected readonly totals = computed(() => {
    const today = todayIso();
    const active = this.rules().filter((r) => r.amount_cents < 0 && nextDue(r, today));
    return { year: active.reduce((sum, r) => sum + yearlyCost(r), 0) };
  });

  ngOnInit(): void {
    void this.load();
  }

  protected when(r: RecurringRule): string {
    const start = new Date(r.start_date + 'T12:00:00');
    const every =
      r.frequency === 'yearly'
        ? `Ogni anno, il ${start.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}`
        : `Ogni mese, il ${start.getDate()}`;
    const next = nextDue(r, todayIso());
    return next ? `${every} · prossima ${italianDate(next)}` : `${every} · finita`;
  }

  protected assignment(r: RecurringRule): string {
    return [
      this.ledger.categoryById().get(r.category_id)?.name,
      this.ledger.bucketById().get(r.bucket_id ?? '')?.name,
      this.ledger.accountById().get(r.account_id)?.name,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected edit(r: RecurringRule): void {
    const kind = this.ledger.categoryById().get(r.category_id)?.kind ?? 'expense';
    this.editing.set(r.id);
    this.name = r.name;
    this.categoryId.set(r.category_id);
    this.bucketId = r.bucket_id ?? '';
    this.amountText = forecastToInput(r.amount_cents, kind, false);
    this.accountId = r.account_id;
    this.frequency = r.frequency;
    this.startDate = r.start_date;
    this.endDate = r.end_date ?? '';
    this.cancelBy = r.cancel_by ?? '';
  }

  protected reset(): void {
    this.editing.set(null);
    this.name = this.bucketId = this.amountText = this.accountId = this.endDate = this.cancelBy = '';
    this.categoryId.set('');
    this.frequency = 'monthly';
    this.startDate = todayIso();
  }

  protected async save(): Promise<void> {
    const kind = this.kind();
    const amount = kind ? inputToForecast(this.amountText, kind) : undefined;
    const account = this.accountId || this.defaultAccount();
    if (!this.name.trim() || !kind || !amount || !account || !this.startDate || (kind !== 'income' && !this.bucketId)) {
      this.snackBar.open('Servono nome, categoria, secchio, un importo, conto e prima scadenza', 'OK', { duration: 5000 });
      return;
    }
    if (this.endDate && this.endDate < this.startDate) {
      this.snackBar.open("L'ultima scadenza non può venire prima della prima", 'OK', { duration: 5000 });
      return;
    }
    const row = {
      name: this.name.trim(),
      category_id: this.categoryId(),
      bucket_id: kind === 'income' ? null : this.bucketId,
      amount_cents: amount,
      account_id: account,
      frequency: this.frequency,
      start_date: this.startDate,
      end_date: this.endDate || null,
      cancel_by: this.cancelBy || null,
    };
    const id = this.editing();
    const res = id ? await supabase.from('recurring_rules').update(row).eq('id', id) : await supabase.from('recurring_rules').insert(row);
    if (!res.error) this.reset();
    this.done(res, 'Ricorrente non salvata');
  }

  protected async remove(r: RecurringRule): Promise<void> {
    if (!confirm(`Eliminare "${r.name}"? I movimenti già creati restano.`)) return;
    this.done(await supabase.from('recurring_rules').delete().eq('id', r.id), 'Ricorrente non eliminata');
  }

  protected async toCalendar(r: RecurringRule): Promise<void> {
    await saveFile(`disdire-${r.id.slice(0, 8)}.ics`, 'text/calendar', reminderIcs(r.id, `Disdire ${r.name}`, r.cancel_by!));
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load();
    void this.ledger.load();
  }

  private async load(): Promise<void> {
    const res = await supabase.from('recurring_rules').select().order('name');
    if (res.data) this.rules.set(res.data);
  }
}
