import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { Database } from '../../core/database.types';
import { errorText, ParseRule, supabase } from '../../core/supabase';

type TestRow = Database['public']['Functions']['test_parse']['Returns'][number];

const ACTIONS = [
  { value: 'expense', label: 'Spesa' },
  { value: 'income', label: 'Entrata' },
  { value: 'authorized', label: 'Spesa da confermare (addebito in arrivo)' },
  { value: 'ignore', label: 'Ignora la notifica' },
];

/** Regole per leggere le notifiche: si modificano senza deploy e si provano su quelle già ricevute. Solo online. */
@Component({
  selector: 'app-rules',
  imports: [FormsModule, MatButtonModule, RouterLink],
  template: `
    <h1>Regole notifiche</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: le regole si modificano solo con la connessione.</p>
    }
    <p class="note">
      Per ogni notifica vale la prima regola dell'app, in ordine di priorità, che riconosce il testo. Ogni regola estrae i dati
      con il primo gruppo tra parentesi di una espressione regolare.
    </p>

    <fieldset [disabled]="!online()">
      <ul>
        @for (r of rules(); track r.id) {
          <li>
            <div class="line">
              <strong>{{ r.app }} · {{ r.priority }}</strong>
              <span class="sub">{{ actionLabel(r.action) }}</span>
            </div>
            <code>{{ r.match_regex }}</code>
            <div class="actions">
              <button mat-stroked-button type="button" (click)="edit(r)">Modifica</button>
              <button mat-button type="button" (click)="remove(r)">Elimina</button>
            </div>
          </li>
        } @empty {
          <p class="note">Nessuna regola: le notifiche finiscono tutte in Da rivedere.</p>
        }
      </ul>

      <form (ngSubmit)="save()">
        <h2>{{ editing() ? 'Modifica regola' : 'Nuova regola' }}</h2>
        <label>App <input name="app" list="elenco-app" autocomplete="off" placeholder="Es. BBVA" [(ngModel)]="app" /></label>
        <datalist id="elenco-app">
          @for (a of apps(); track a) {
            <option [value]="a"></option>
          }
        </datalist>
        <label>Priorità (prima i numeri più bassi) <input name="priority" type="number" [(ngModel)]="priority" /></label>
        <label>Riconosce il testo con <input name="match" autocomplete="off" spellcheck="false" [(ngModel)]="match" /></label>
        <label>
          Azione
          <select name="action" [ngModel]="action()" (ngModelChange)="action.set($event)">
            @for (a of actions; track a.value) {
              <option [value]="a.value">{{ a.label }}</option>
            }
          </select>
        </label>
        @if (action() !== 'ignore') {
          <label>Importo <input name="amount" autocomplete="off" spellcheck="false" [(ngModel)]="amount" /></label>
          <label>Esercente <input name="merchant" autocomplete="off" spellcheck="false" [(ngModel)]="merchant" /></label>
          <label>Ultime cifre della carta (facoltativo) <input name="card" autocomplete="off" spellcheck="false" [(ngModel)]="card" /></label>
        }
        @if (error()) {
          <p class="warn" role="alert">{{ error() }}</p>
        }
        <div class="actions">
          @if (editing()) {
            <button mat-button type="button" (click)="reset()">Annulla</button>
          }
          <button mat-stroked-button type="button" (click)="test()">Prova</button>
          <button mat-flat-button type="submit">Salva</button>
        </div>
      </form>

      @if (results(); as rows) {
        <section aria-label="Risultato della prova">
          <h2>Prova sulle ultime notifiche di {{ app }}: {{ recognized() }} su {{ rows.length }} riconosciute</h2>
          <ul>
            @for (t of rows; track $index) {
              <li>
                <span class="sub">{{ t.matched ? 'Riconosciuta' : 'Non riconosciuta' }}</span>
                <!-- Testo della notifica: solo testo, mai HTML. -->
                <span class="text">{{ t.notification }}</span>
                @if (t.matched) {
                  <strong>{{ t.amount_cents === null ? 'Importo non trovato' : fmt(t.amount_cents) }} · {{ t.merchant || 'senza esercente' }}{{ t.card ? ' · carta *' + t.card : '' }}</strong>
                }
              </li>
            } @empty {
              <p class="note">Nessuna notifica ricevuta da questa app.</p>
            }
          </ul>
        </section>
      }

      <p class="note">Dopo aver cambiato una regola, le notifiche non riconosciute si riprovano da <a routerLink="/da-rivedere">Da rivedere</a>.</p>
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
    .sub {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    code,
    .text {
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
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
    p {
      margin: 0;
    }
    .note {
      color: var(--mat-sys-on-surface-variant);
    }
    .warn {
      color: var(--mat-sys-error);
    }
  `,
})
export class Rules implements OnInit {
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly actions = ACTIONS;
  protected readonly rules = signal<ParseRule[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected readonly action = signal('expense');
  protected readonly error = signal('');
  protected readonly results = signal<TestRow[] | null>(null);
  protected app = '';
  protected priority = 10;
  protected match = '';
  protected amount = '([0-9][0-9.,]*)\\s*EUR';
  protected merchant = '';
  protected card = '';

  protected readonly apps = computed(() => [...new Set(this.rules().map((r) => r.app))]);
  protected readonly recognized = computed(() => (this.results() ?? []).filter((t) => t.matched).length);

  ngOnInit(): void {
    void this.load();
  }

  protected actionLabel(action: string): string {
    return ACTIONS.find((a) => a.value === action)?.label ?? action;
  }

  protected edit(r: ParseRule): void {
    this.editing.set(r.id);
    this.app = r.app;
    this.priority = r.priority;
    this.match = r.match_regex;
    this.action.set(r.action);
    this.amount = r.amount_regex ?? '';
    this.merchant = r.merchant_regex ?? '';
    this.card = r.card_regex ?? '';
    this.error.set('');
    this.results.set(null);
  }

  protected reset(): void {
    this.editing.set(null);
    this.app = this.match = this.merchant = this.card = '';
    this.priority = 10;
    this.amount = '([0-9][0-9.,]*)\\s*EUR';
    this.action.set('expense');
    this.error.set('');
    this.results.set(null);
  }

  /** Prova la regola così com'è scritta, anche se non è ancora salvata. */
  protected async test(): Promise<void> {
    if (!this.app.trim() || !this.match.trim()) {
      this.error.set('Per provare servono app e testo da riconoscere.');
      return;
    }
    const res = await supabase.rpc('test_parse', {
      p_app: this.app.trim(),
      p_match: this.match,
      p_amount: this.amount,
      p_merchant: this.merchant,
      p_card: this.card,
    });
    this.error.set(res.error ? 'Regola non valida: ' + errorText(res) : '');
    this.results.set(res.data);
  }

  protected async save(): Promise<void> {
    const ignore = this.action() === 'ignore';
    if (!this.app.trim() || !this.match.trim() || (!ignore && !this.amount.trim())) {
      this.error.set('Servono app, testo da riconoscere e, se non si ignora, l\'importo.');
      return;
    }
    const row = {
      app: this.app.trim(),
      priority: this.priority,
      match_regex: this.match,
      action: this.action(),
      amount_regex: ignore ? null : this.amount,
      merchant_regex: ignore ? null : this.merchant || null,
      card_regex: ignore ? null : this.card || null,
    };
    const id = this.editing();
    const res = id ? await supabase.from('parse_rules').update(row).eq('id', id) : await supabase.from('parse_rules').insert(row);
    if (res.error) {
      this.error.set('Regola non salvata: ' + errorText(res));
      return;
    }
    this.reset();
    this.snackBar.open('Regola salvata', 'OK', { duration: 3000 });
    await this.load();
  }

  protected async remove(r: ParseRule): Promise<void> {
    if (!confirm(`Eliminare questa regola di ${r.app}? Le sue notifiche finiranno in Da rivedere.`)) return;
    const res = await supabase.from('parse_rules').delete().eq('id', r.id);
    if (res.error) this.snackBar.open('Regola non eliminata: ' + errorText(res), 'OK');
    await this.load();
  }

  private async load(): Promise<void> {
    const res = await supabase.from('parse_rules').select().order('app').order('priority').order('created_at');
    if (res.data) this.rules.set(res.data);
  }
}
