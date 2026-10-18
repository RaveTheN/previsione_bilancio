import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Auth } from '../../core/auth';
import { Ledger } from '../../core/ledger';
import { centsToInput, parseSignedAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { Account, Category, errorText, supabase } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { Devices } from './devices';

const KINDS = [
  { value: 'income', label: 'Entrate' },
  { value: 'saving', label: 'Risparmio' },
  { value: 'expense', label: 'Spese' },
] as const;

/** Svuota le copie dei dati salvate dal service worker (non l'app stessa). */
async function clearDataCaches(): Promise<void> {
  if (!('caches' in window)) return;
  for (const key of await caches.keys()) {
    if (key.includes(':data:')) await caches.delete(key);
  }
}

@Component({
  selector: 'app-settings',
  imports: [Devices, FormsModule, MatButtonModule],
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

    @if (!online()) {
      <p class="warn" role="status">Sei offline: impostazioni, categorie, conti e dispositivi si modificano solo con la connessione.</p>
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
          Risparmio previsto (% dello stipendio previsto)
          <input inputmode="decimal" [value]="ledger.settings()?.savings_pct ?? 15" (change)="setSavingsPct(value($event))" />
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
      </div>
    </section>

    <section>
      <h2>Categorie</h2>
      @for (kind of kinds; track kind.value) {
        <h3>{{ kind.label }}</h3>
        <ul>
          @for (c of byKind(kind.value); track c.id; let first = $first, last = $last) {
            <li>
              <input [value]="c.name" aria-label="Nome della categoria" (change)="update('categories', c.id, { name: value($event) })" />
              <button type="button" class="icon" aria-label="Sposta su" [disabled]="first" (click)="move(c, -1)">
                <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M440-160v-487L216-423l-56-57 320-320 320 320-56 57-224-224v487h-80Z" /></svg>
              </button>
              <button type="button" class="icon" aria-label="Sposta giù" [disabled]="last" (click)="move(c, 1)">
                <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487h-80Z" /></svg>
              </button>
              <label class="check">
                <input type="checkbox" [checked]="c.archived" (change)="update('categories', c.id, { archived: checked($event) })" />
                Archiviata
              </label>
            </li>
          }
        </ul>
      }
      <form class="row" (ngSubmit)="addCategory()">
        <input name="newCategory" placeholder="Nuova categoria" aria-label="Nuova categoria" required [(ngModel)]="newCategory" />
        <select name="newKind" aria-label="Tipo" [(ngModel)]="newKind">
          @for (kind of kinds; track kind.value) {
            <option [value]="kind.value">{{ kind.label }}</option>
          }
        </select>
        <button mat-stroked-button type="submit" [disabled]="!newCategory.trim()">Aggiungi</button>
      </form>
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

    <section>
      <button mat-stroked-button type="button" (click)="signOut()">Esci</button>
    </section>
  `,
  styles: `
    :host,
    fieldset {
      display: grid;
      gap: 24px;
    }
    fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    h1,
    h2,
    h3 {
      margin: 0 0 8px;
    }
    h1 {
      font: var(--mat-sys-title-large);
    }
    h2 {
      font: var(--mat-sys-title-medium);
    }
    h3 {
      margin-top: 12px;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li,
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 48px;
    }
    li input:not([type='checkbox']),
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
    .icon {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border: 0;
      background: none;
      color: var(--mat-sys-on-surface);
      cursor: pointer;
    }
    .icon:disabled {
      opacity: 0.3;
    }
    .icon svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
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
  `,
})
export class Settings {
  protected readonly ledger = inject(Ledger);
  protected readonly sync = inject(Sync);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly kinds = KINDS;

  protected newCategory = '';
  protected newKind: Category['kind'] = 'expense';
  protected newAccount = '';

  /** Le impostazioni si salvano solo online: la coda offline copre i movimenti. */
  protected readonly online = onlineSignal();

  protected byKind(kind: string): Category[] {
    return this.ledger.categories().filter((c) => c.kind === kind);
  }

  protected value(e: Event): string {
    return (e.target as HTMLInputElement).value.trim();
  }

  protected checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  protected centsToText(cents: number | null | undefined): string {
    return cents == null ? '' : centsToInput(cents);
  }

  protected async update(table: 'categories' | 'accounts', id: string, patch: Record<string, unknown>): Promise<void> {
    this.done(await supabase.from(table).update(patch as never).eq('id', id), 'Modifica non salvata');
  }

  /** La riga delle impostazioni nasce al primo salvataggio; i campi non inviati restano com'erano. */
  protected async saveSettings(patch: {
    go_live_month?: string;
    opening_residual_cents?: number;
    savings_pct?: number;
    savings_bucket_id?: string | null;
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

  protected setSavingsPct(text: string): void {
    const pct = Number(text.replace(',', '.'));
    if (!text || !(pct >= 0 && pct <= 100)) {
      this.invalid('Percentuale non valida: da 0 a 100');
      return;
    }
    void this.saveSettings({ savings_pct: pct });
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

  /** Riordina scambiando con la vicina e rinumerando l'elenco del tipo. */
  protected async move(c: Category, delta: number): Promise<void> {
    const list = this.byKind(c.kind);
    const i = list.indexOf(c);
    [list[i], list[i + delta]] = [list[i + delta], list[i]];
    const changes = list.map((x, order) => ({ x, order })).filter(({ x, order }) => x.sort_order !== order);
    const results = await Promise.all(
      changes.map(({ x, order }) => supabase.from('categories').update({ sort_order: order }).eq('id', x.id)),
    );
    this.done(results.find((r) => r.error) ?? { error: null, status: 200 }, 'Ordine non salvato');
  }

  protected async addCategory(): Promise<void> {
    const order = Math.max(-1, ...this.byKind(this.newKind).map((c) => c.sort_order)) + 1;
    const res = await supabase
      .from('categories')
      .insert({ name: this.newCategory.trim(), kind: this.newKind, sort_order: order });
    if (!res.error) this.newCategory = '';
    this.done(res, res.error?.code === '23505' ? 'Esiste già una categoria con questo nome' : 'Categoria non aggiunta');
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
