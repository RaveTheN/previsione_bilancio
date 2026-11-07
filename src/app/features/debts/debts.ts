import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { italianDate } from '../../core/files';
import { Ledger, todayIso } from '../../core/ledger';
import { centsToInput, formatCents, parseAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { DebtPlan, errorText, supabase } from '../../core/supabase';
import { PAGE_STYLES } from '../../shared/page-styles';

/** Debiti e rate: residuo e data di fine vengono dal piano. Solo online. */
@Component({
  selector: 'app-debts',
  imports: [FormsModule, MatButtonModule],
  template: `
    <h1>Debiti e rate</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: i debiti si modificano solo con la connessione.</p>
    }

    <section class="card" aria-label="Totale dei debiti">
      <span class="label">Ancora da pagare</span>
      <strong>{{ fmt(totals().left) }} · {{ fmt(totals().month) }} al mese</strong>
    </section>

    <p class="note">
      Tutto è calcolato dal piano: una rata conta come pagata dal giorno della sua scadenza. Se ne salti o ne anticipi una, l'app non
      può saperlo. Il peso sulle entrate si vede nella pagina Mese.
    </p>

    <fieldset [disabled]="!online()">
      <ul>
        @for (d of debts(); track d.id) {
          <li>
            <div class="line">
              <strong>{{ d.name }}</strong>
              <span class="num">{{ fmt(d.remaining_cents) }}</span>
            </div>
            <span class="sub">{{ fmt(d.installment_cents) }} al mese · {{ d.paid }} di {{ d.n_installments }} rate pagate</span>
            <span class="sub">
              @if (d.next_due_date) {
                Prossima rata {{ date(d.next_due_date) }} · ultima {{ date(d.last_due_date) }}
              } @else {
                Finito il {{ date(d.last_due_date) }}
              }
            </span>
            <div class="actions">
              <button mat-stroked-button type="button" (click)="edit(d)">Modifica</button>
              <button mat-button type="button" (click)="remove(d)">Elimina</button>
            </div>
          </li>
        } @empty {
          <p class="note">Ancora nessuno.</p>
        }
      </ul>

      <form (ngSubmit)="save()">
        <h2>{{ editing() ? 'Modifica debito' : 'Nuovo debito' }}</h2>
        <label>Nome <input name="name" autocomplete="off" placeholder="Es. Prestito moto" [(ngModel)]="name" /></label>
        <label>Importo della rata (€) <input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" [(ngModel)]="amountText" /></label>
        <label>Prima rata (dà il giorno di ogni scadenza) <input type="date" name="first" [(ngModel)]="firstDue" /></label>
        <label>Numero di rate <input name="count" inputmode="numeric" autocomplete="off" [(ngModel)]="countText" /></label>
        <div class="actions">
          @if (editing()) {
            <button mat-button type="button" (click)="reset()">Annulla</button>
          }
          <button mat-flat-button type="submit">Salva</button>
        </div>
      </form>
    </fieldset>
  `,
  styles: [PAGE_STYLES],
})
export class Debts implements OnInit {
  private readonly ledger = inject(Ledger);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly date = italianDate;
  protected readonly debts = signal<DebtPlan[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected name = '';
  protected amountText = '';
  protected firstDue = todayIso();
  protected countText = '';

  /** La rata al mese conta solo per i debiti non ancora finiti. */
  protected readonly totals = computed(() => ({
    left: this.debts().reduce((sum, d) => sum + d.remaining_cents, 0),
    month: this.debts().reduce((sum, d) => sum + (d.next_due_date ? d.installment_cents : 0), 0),
  }));

  ngOnInit(): void {
    void this.load();
  }

  protected edit(d: DebtPlan): void {
    this.editing.set(d.id);
    this.name = d.name;
    this.amountText = centsToInput(d.installment_cents);
    this.firstDue = d.first_due_date;
    this.countText = String(d.n_installments);
  }

  protected reset(): void {
    this.editing.set(null);
    this.name = this.amountText = this.countText = '';
    this.firstDue = todayIso();
  }

  protected async save(): Promise<void> {
    const amount = parseAmount(this.amountText);
    const count = Number(this.countText);
    if (!this.name.trim() || !amount || !this.firstDue || !Number.isInteger(count) || count < 1 || count > 1200) {
      this.snackBar.open('Servono nome, importo della rata, prima rata e numero di rate', 'OK', { duration: 5000 });
      return;
    }
    const row = { name: this.name.trim(), installment_cents: amount, first_due_date: this.firstDue, n_installments: count };
    const id = this.editing();
    const res = id ? await supabase.from('debts').update(row).eq('id', id) : await supabase.from('debts').insert(row);
    if (!res.error) this.reset();
    this.done(res, 'Debito non salvato');
  }

  protected async remove(d: DebtPlan): Promise<void> {
    if (!confirm(`Eliminare "${d.name}"? I movimenti già registrati restano.`)) return;
    this.done(await supabase.from('debts').delete().eq('id', d.id), 'Debito non eliminato');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load();
    void this.ledger.load();
  }

  private async load(): Promise<void> {
    // In GET: il service worker la conserva per la lettura offline.
    const res = await supabase.rpc('debt_plan', {}, { get: true });
    if (res.data) this.debts.set(res.data);
  }
}
