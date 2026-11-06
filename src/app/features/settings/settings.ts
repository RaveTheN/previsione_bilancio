import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Auth } from '../../core/auth';
import { Ledger, monthLabel } from '../../core/ledger';
import { centsToInput, formatCents, parseSignedAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { Account, errorText, supabase } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { Devices } from './devices';
import { Exports } from './exports';

const percent = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 1 });

/** Svuota le copie dei dati salvate dal service worker (non l'app stessa). */
async function clearDataCaches(): Promise<void> {
  if (!('caches' in window)) return;
  for (const key of await caches.keys()) {
    if (key.includes(':data:')) await caches.delete(key);
  }
}

@Component({
  selector: 'app-settings',
  imports: [Devices, Exports, FormsModule, MatButtonModule, RouterLink],
  template: `
    <h1>Altro</h1>

    <section>
      <h2>Sincronizzazione</h2>
      <p>{{ sync.ops().length ? sync.ops().length + ' modifiche in attesa di invio' : 'Tutto sincronizzato' }}</p>
      @if (sync.error()) {
        <p class="warn" role="alert">Invio bloccato: {{ sync.error() }}</p>
        <div class="row">
          <button mat-stroked-button type="button" (click)="sync.flush()">Riprova</button>
          <button mat-button type="button" (click)="sync.discardFirst()">Scarta la modifica bloccata</button>
        </div>
      }
    </section>

    <nav class="links" aria-label="Altre pagine">
      <!-- Sugli schermi larghi Categorie sta nella barra laterale. -->
      <a class="link narrow" routerLink="/categorie">Categorie</a>
      <a class="link" routerLink="/rubrica">Rubrica degli esercenti</a>
      <a class="link" routerLink="/ricorrenti">Ricorrenti</a>
      <a class="link" routerLink="/debiti">Debiti e rate</a>
      <a class="link" routerLink="/desideri">Lista dei desideri</a>
      <a class="link" routerLink="/condivise">Spese condivise</a>
      <a class="link" routerLink="/regole">Regole notifiche</a>
    </nav>

    @if (!online()) {
      <p class="warn" role="status">Sei offline: impostazioni, conti e dispositivi si modificano solo con la connessione.</p>
    }

    <fieldset [disabled]="!online()">
    <section>
      <h2>Bilancio</h2>
      <div class="account">
        <label>
          Mese di avvio
          <input type="month" [value]="ledger.settings()?.go_live_month?.slice(0, 7) ?? ''" (change)="setGoLive(value($event))" />
        </label>
        <label>
          Residuo all'avvio (€): il disponibile sui conti spendibili all'inizio di quel mese
          <input inputmode="decimal" [value]="centsToText(ledger.settings()?.opening_residual_cents)" (change)="setOpening(value($event))" />
        </label>
        <label>
          Risparmio previsto: importo fisso al mese (€)
          <input
            inputmode="decimal"
            placeholder="vuoto = percentuale dello stipendio"
            [value]="centsToText(ledger.settings()?.savings_amount_cents)"
            (change)="setSavingsAmount(value($event))"
          />
        </label>
        @if (derivedPct()) {
          <p class="note">{{ derivedPct() }}</p>
        }
        <label>
          Oppure in percentuale dello stipendio previsto (%)
          <input
            inputmode="decimal"
            [disabled]="ledger.settings()?.savings_amount_cents != null"
            [value]="ledger.settings()?.savings_pct ?? 15"
            (change)="setSavingsPct(value($event))"
          />
        </label>
        <label>
          Secchio del risparmio (accantonamenti e previsione)
          <select (change)="saveSettings({ savings_bucket_id: value($event) || null })">
            <option value="" [selected]="!ledger.settings()?.savings_bucket_id">Nessuno</option>
            @for (b of ledger.buckets(); track b.id) {
              <option [value]="b.id" [selected]="b.id === ledger.settings()?.savings_bucket_id">{{ b.name }}</option>
            }
          </select>
        </label>
        <label>
          Tasso annuo su conti e Salvadanaio (%), per la stima degli interessi
          <input inputmode="decimal" placeholder="vuoto = nessuna stima" [value]="ledger.settings()?.interest_rate_pct ?? ''" (change)="setInterestRate(value($event))" />
        </label>
        <p class="note">La stima, al netto del 26% di ritenuta, compare nella previsione del mese come riga della categoria Interessi.</p>
        <label>
          Secchio dei desideri (il semaforo guarda quanto ne resta)
          <select (change)="saveSettings({ wishlist_bucket_id: value($event) || null })">
            <option value="" [selected]="!ledger.settings()?.wishlist_bucket_id">Nessuno</option>
            @for (b of ledger.buckets(); track b.id) {
              <option [value]="b.id" [selected]="b.id === ledger.settings()?.wishlist_bucket_id">{{ b.name }}</option>
            }
          </select>
        </label>
      </div>
    </section>

    <section>
      <h2>Conti</h2>
      @for (a of ledger.accounts(); track a.id) {
        <div class="account">
          <input [value]="a.name" aria-label="Nome del conto" (change)="update('accounts', a.id, { name: value($event) })" />
          <select [value]="a.role" aria-label="Ruolo del conto" (change)="update('accounts', a.id, { role: value($event) })">
            <option value="spendable">Spendibile</option>
            <option value="reserve">Riserva</option>
          </select>
          <label>
            Saldo di riferimento (€)
            <input inputmode="decimal" [value]="centsToText(a.balance_cents)" (change)="setBalance(a, value($event))" />
          </label>
          <label>
            al
            <input type="date" [value]="a.balance_date ?? ''" (change)="update('accounts', a.id, { balance_date: value($event) || null })" />
          </label>
          <p class="note">{{ currentText(a) }}</p>
          <label class="check">
            <input type="checkbox" [checked]="a.archived" (change)="update('accounts', a.id, { archived: checked($event) })" />
            Archiviato
          </label>
        </div>
      }
      <form class="row" (ngSubmit)="addAccount()">
        <input name="newAccount" placeholder="Nuovo conto" aria-label="Nuovo conto" required [(ngModel)]="newAccount" />
        <button mat-stroked-button type="submit" [disabled]="!newAccount.trim()">Aggiungi</button>
      </form>
    </section>

    <app-devices />
    </fieldset>

    <app-exports />

    <section>
      <button mat-stroked-button type="button" (click)="signOut()">Esci</button>
    </section>
  `,
  styles: `
    :host,
    fieldset {
      display: grid;
      /* Senza minmax una riga larga allargherebbe la colonna oltre lo schermo. */
      grid-template-columns: minmax(0, 1fr);
      gap: 24px;
    }
    fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    h1,
    h2 {
      margin: 0 0 8px;
    }
    h1 {
      font: var(--mat-sys-title-large);
    }
    h2 {
      font: var(--mat-sys-title-medium);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      min-height: 48px;
    }
    .row input {
      flex: 1;
      min-width: 0;
    }
    input:not([type='checkbox']),
    select {
      min-height: 44px;
      padding: 0 8px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-large);
    }
    .check {
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .account {
      display: grid;
      gap: 8px;
      padding: 12px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .account label:not(.check) {
      display: grid;
      gap: 4px;
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .note {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    .link {
      display: flex;
      align-items: center;
      min-height: 48px;
      font: var(--mat-sys-title-medium);
    }
    @media (min-width: 840px) {
      .narrow {
        display: none;
      }
    }
  `,
})
export class Settings {
  protected readonly ledger = inject(Ledger);
  protected readonly sync = inject(Sync);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly balances = signal(new Map<string | null, number | null>());

  constructor() {
    // Si ricarica quando cambiano i conti: dopo ogni salvataggio il Ledger li rilegge.
    effect(() => {
      this.ledger.accounts();
      untracked(() => void this.loadBalances());
    });
  }

  protected newAccount = '';

  /** Le impostazioni si salvano solo online: la coda offline copre i movimenti. */
  protected readonly online = onlineSignal();

  protected value(e: Event): string {
    return (e.target as HTMLInputElement).value.trim();
  }

  protected checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  protected centsToText(cents: number | null | undefined): string {
    return cents == null ? '' : centsToInput(cents);
  }

  protected async update(table: 'accounts', id: string, patch: Record<string, unknown>): Promise<void> {
    this.done(await supabase.from(table).update(patch as never).eq('id', id), 'Modifica non salvata');
  }

  /** La riga delle impostazioni nasce al primo salvataggio; i campi non inviati restano com'erano. */
  protected async saveSettings(patch: {
    go_live_month?: string;
    opening_residual_cents?: number;
    savings_pct?: number;
    savings_amount_cents?: number | null;
    savings_bucket_id?: string | null;
    interest_rate_pct?: number | null;
    wishlist_bucket_id?: string | null;
  }): Promise<void> {
    this.done(await supabase.from('settings').upsert(patch), 'Impostazione non salvata');
  }

  protected setGoLive(month: string): void {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      this.invalid('Mese non valido');
      return;
    }
    void this.saveSettings({ go_live_month: month + '-01' });
  }

  protected setOpening(text: string): void {
    const cents = parseSignedAmount(text);
    if (cents === null) {
      this.invalid('Importo non valido');
      return;
    }
    void this.saveSettings({ opening_residual_cents: cents });
  }

  /** Vuoto = torna alla percentuale. */
  protected setSavingsAmount(text: string): void {
    const cents = text === '' ? null : parseSignedAmount(text);
    if (text !== '' && (cents === null || cents < 0)) {
      this.invalid('Importo non valido');
      return;
    }
    void this.saveSettings({ savings_amount_cents: cents });
  }

  /** La percentuale che l'importo fisso rappresenta sullo stipendio previsto del mese selezionato. */
  protected readonly derivedPct = computed(() => {
    const amount = this.ledger.settings()?.savings_amount_cents;
    if (amount == null) return '';
    const cats = this.ledger.categoryById();
    const salary = (this.ledger.overview()?.lines ?? [])
      .filter((l) => cats.get(l.category_id ?? '')?.is_salary)
      .reduce((sum, l) => sum + (l.forecast ?? 0), 0);
    const month = monthLabel(this.ledger.month());
    return salary > 0
      ? `= ${percent.format(amount / salary)} dello stipendio previsto di ${month}`
      : `La percentuale si vede quando ${month} ha uno stipendio previsto.`;
  });

  protected setSavingsPct(text: string): void {
    const pct = Number(text.replace(',', '.'));
    if (!text || !(pct >= 0 && pct <= 100)) {
      this.invalid('Percentuale non valida: da 0 a 100');
      return;
    }
    void this.saveSettings({ savings_pct: pct });
  }

  /** Vuoto = nessuna stima degli interessi. */
  protected setInterestRate(text: string): void {
    const pct = Number(text.replace(',', '.'));
    if (text && !(pct >= 0 && pct <= 100)) {
      this.invalid('Tasso non valido: da 0 a 100');
      return;
    }
    void this.saveSettings({ interest_rate_pct: text ? pct : null });
  }

  /** Il saldo attuale è calcolato dal database: saldo di riferimento più i movimenti successivi alla sua data. */
  protected currentText(a: Account): string {
    if (a.archived) return 'Archiviato: non conta nel saldo totale.';
    const current = this.balances().get(a.id);
    return current == null
      ? 'Inserisci il saldo reale e la sua data per vedere quello attuale.'
      : `Saldo attuale: ${formatCents(current)} (il saldo qui sopra più i movimenti successivi)`;
  }

  private async loadBalances(): Promise<void> {
    const res = await supabase.from('account_balances').select();
    if (res.data) this.balances.set(new Map(res.data.map((b) => [b.account_id, b.current_cents])));
  }

  protected setBalance(a: Account, text: string): void {
    const cents = text === '' ? null : parseSignedAmount(text);
    if (text !== '' && cents === null) {
      this.invalid('Importo non valido');
      return;
    }
    void this.update('accounts', a.id, { balance_cents: cents });
  }

  /** Il campo resta com'era: ricaricando, torna il valore salvato. */
  private invalid(message: string): void {
    this.snackBar.open(message, 'OK', { duration: 4000 });
    void this.ledger.load();
  }

  protected async addAccount(): Promise<void> {
    const order = Math.max(-1, ...this.ledger.accounts().map((a) => a.sort_order)) + 1;
    const res = await supabase.from('accounts').insert({ name: this.newAccount.trim(), sort_order: order });
    if (!res.error) this.newAccount = '';
    this.done(res, res.error?.code === '23505' ? 'Esiste già un conto con questo nome' : 'Conto non aggiunto');
  }

  /** Prima prova a inviare le modifiche in attesa: uscire le cancellerebbe. */
  protected async signOut(): Promise<void> {
    await this.sync.flush();
    const pending = this.sync.ops().length;
    if (pending && !confirm(`${pending} modifiche non sono ancora state inviate e andrebbero perse. Uscire comunque?`)) {
      return;
    }
    this.sync.clear();
    await clearDataCaches();
    await this.auth.signOut();
    await this.router.navigateByUrl('/accesso');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.ledger.load();
  }
}
