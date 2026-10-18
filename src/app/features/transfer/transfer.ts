import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { Ledger, todayIso } from '../../core/ledger';
import { parseAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, supabase } from '../../core/supabase';

/** Trasferimento tra due conti; verso il Salvadanaio è l'accantonamento manuale. Solo online. */
@Component({
  selector: 'app-transfer',
  imports: [FormsModule, MatButtonModule],
  template: `
    <form (ngSubmit)="save()">
      <h2>Trasferimento</h2>
      <label>
        Da
        <select name="from" [ngModel]="from()" (ngModelChange)="from.set($event)">
          @for (a of accounts(); track a.id) {
            <option [value]="a.id">{{ a.name }}</option>
          }
        </select>
      </label>
      <label>
        A
        <select name="to" [ngModel]="to()" (ngModelChange)="to.set($event)">
          @for (a of accounts(); track a.id) {
            <option [value]="a.id">{{ a.name }}</option>
          }
        </select>
      </label>
      <label>
        Importo (€)
        <input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" [(ngModel)]="amountText" />
      </label>
      <label>Data <input type="date" name="date" required [(ngModel)]="date" /></label>
      <label>Nota <input name="note" autocomplete="off" [(ngModel)]="note" /></label>

      <p class="note">{{ kindText() }}</p>
      @if (!online()) {
        <p class="error" role="status">Sei offline: il trasferimento richiede la connessione.</p>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <div class="actions">
        <button mat-flat-button type="submit" [disabled]="busy() || !online()">Trasferisci</button>
      </div>
    </form>
  `,
  styles: `
    form {
      display: grid;
      gap: 12px;
      padding: 8px 4px calc(8px + env(safe-area-inset-bottom));
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    label {
      display: grid;
      gap: 4px;
      font: var(--mat-sys-label-large);
    }
    input,
    select {
      min-height: 44px;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    p {
      margin: 0;
    }
    .note {
      color: var(--mat-sys-on-surface-variant);
    }
    .error {
      color: var(--mat-sys-error);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
    }
    .actions button {
      min-height: 48px;
    }
  `,
})
export class TransferSheet {
  private readonly ledger = inject(Ledger);
  private readonly ref = inject(MatBottomSheetRef<TransferSheet, string>);
  // Stesso id per tutta la vita del foglio: se una risposta si perde, riprovare non crea un doppione.
  private readonly id = crypto.randomUUID();
  protected readonly online = onlineSignal();
  protected readonly accounts = computed(() => this.ledger.accounts().filter((a) => !a.archived));
  protected readonly from = signal(this.accounts().find((a) => a.role === 'spendable')?.id ?? '');
  protected readonly to = signal(this.accounts().find((a) => a.role === 'reserve')?.id ?? '');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected amountText = '';
  protected date = todayIso();
  protected note = '';

  protected readonly kindText = computed(() => {
    const role = (id: string) => this.ledger.accountById().get(id)?.role;
    const [from, to] = [role(this.from()), role(this.to())];
    if (!from || !to || this.from() === this.to()) return 'Scegli due conti diversi.';
    if (from === to) return 'Trasferimento: resta fuori da entrate e uscite.';
    return from === 'spendable' ? 'Accantonamento: conta come risparmio.' : 'Prelievo dalla riserva: riduce il risparmio del mese.';
  });

  protected async save(): Promise<void> {
    const cents = parseAmount(this.amountText);
    if (!cents) {
      this.error.set('Importo non valido');
      return;
    }
    this.busy.set(true);
    const res = await supabase.rpc('create_transfer', {
      p_id: this.id,
      p_from: this.from(),
      p_to: this.to(),
      p_amount_cents: cents,
      p_booking_date: this.date,
      p_note: this.note,
    });
    this.busy.set(false);
    if (res.error) {
      this.error.set('Non trasferito: ' + errorText(res));
      return;
    }
    void this.ledger.load();
    this.ref.dismiss(this.id);
  }
}
