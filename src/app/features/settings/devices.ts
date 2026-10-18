import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Ledger } from '../../core/ledger';
import { ApiToken, Card, errorText, supabase } from '../../core/supabase';

/** 32 byte casuali in base64url: il token si mostra una volta, nel database va solo l'hash. */
async function newToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return { token, hash: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') };
}

/** Token dei Comandi Rapidi e carte collegate ai conti. Solo online (dentro il fieldset di Altro). */
@Component({
  selector: 'app-devices',
  imports: [FormsModule, MatButtonModule],
  template: `
    <section>
      <h2>Dispositivi</h2>
      <p class="note">I Comandi Rapidi usano un token per inviare le notifiche: può solo aggiungere movimenti, non legge nulla.</p>
      <ul>
        @for (t of tokens(); track t.id) {
          <li>
            <span>{{ t.name }} · {{ status(t) }}</span>
            @if (!t.revoked_at) {
              <button mat-button type="button" (click)="revoke(t)">Revoca</button>
            }
          </li>
        }
      </ul>
      <form class="row" (ngSubmit)="createToken()">
        <input name="tokenName" placeholder="Nome, es. iPhone" aria-label="Nome del dispositivo" [(ngModel)]="tokenName" />
        <button mat-stroked-button type="submit" [disabled]="!tokenName.trim()">Crea token</button>
      </form>
      @if (shown()) {
        <div class="token" role="status">
          <code>{{ shown() }}</code>
          <button mat-stroked-button type="button" (click)="copy()">Copia</button>
          <p class="warn">Incollalo ora nel Comando Rapido "Bilancio · Invia": non verrà più mostrato.</p>
        </div>
      }
    </section>

    <section>
      <h2>Carte</h2>
      <p class="note">Le ultime 4 cifre che compaiono nelle notifiche, con il conto che addebitano.</p>
      <ul>
        @for (c of cards(); track c.id) {
          <li>
            <span>*{{ c.last4 }} → {{ ledger.accountById().get(c.account_id)?.name }}</span>
            <button mat-button type="button" (click)="removeCard(c)">Elimina</button>
          </li>
        }
      </ul>
      <form class="row" (ngSubmit)="addCard()">
        <input name="last4" inputmode="numeric" maxlength="4" placeholder="1234" aria-label="Ultime 4 cifre" [(ngModel)]="last4" />
        <select name="cardAccount" aria-label="Conto" [(ngModel)]="cardAccount">
          @for (a of spendable(); track a.id) {
            <option [value]="a.id">{{ a.name }}</option>
          }
        </select>
        <button mat-stroked-button type="submit" [disabled]="!validLast4()">Aggiungi</button>
      </form>
    </section>
  `,
  styles: `
    section {
      display: grid;
      gap: 8px;
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
    li,
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 48px;
    }
    .row input {
      flex: 1;
      min-width: 0;
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
    .token {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    code {
      overflow-wrap: anywhere;
      user-select: all;
    }
    .note,
    .warn {
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
export class Devices implements OnInit {
  protected readonly ledger = inject(Ledger);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly tokens = signal<Pick<ApiToken, 'id' | 'name' | 'last_used_at' | 'revoked_at'>[]>([]);
  protected readonly cards = signal<Card[]>([]);
  protected readonly shown = signal('');
  protected readonly spendable = computed(() => this.ledger.accounts().filter((a) => a.role === 'spendable' && !a.archived));
  protected tokenName = '';
  protected last4 = '';
  protected cardAccount = '';

  ngOnInit(): void {
    void this.load();
  }

  protected validLast4(): boolean {
    return /^\d{4}$/.test(this.last4);
  }

  protected status(t: { last_used_at: string | null; revoked_at: string | null }): string {
    if (t.revoked_at) return 'revocato';
    if (!t.last_used_at) return 'mai usato';
    return 'ultimo uso ' + new Date(t.last_used_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  }

  protected async createToken(): Promise<void> {
    const { token, hash } = await newToken();
    const res = await supabase.from('api_tokens').insert({ name: this.tokenName.trim(), token_hash: hash });
    if (!res.error) {
      this.shown.set(token);
      this.tokenName = '';
    }
    this.done(res, 'Token non creato');
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.shown());
      this.snackBar.open('Token copiato', 'OK', { duration: 3000 });
    } catch {
      this.snackBar.open('Copia non riuscita: selezionalo e copialo a mano', 'OK');
    }
  }

  protected async revoke(t: { id: string; name: string }): Promise<void> {
    if (!confirm(`Revocare il token "${t.name}"? Il dispositivo non potrà più inviare notifiche.`)) return;
    this.done(await supabase.from('api_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', t.id), 'Non revocato');
  }

  protected async addCard(): Promise<void> {
    const account = this.cardAccount || this.spendable()[0]?.id;
    if (!account || !this.validLast4()) return;
    const res = await supabase.from('cards').insert({ last4: this.last4, account_id: account });
    if (!res.error) this.last4 = '';
    this.done(res, res.error?.code === '23505' ? 'Carta già collegata' : 'Carta non aggiunta');
  }

  protected async removeCard(c: Card): Promise<void> {
    this.done(await supabase.from('cards').delete().eq('id', c.id), 'Carta non eliminata');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load();
  }

  private async load(): Promise<void> {
    const [tokens, cards] = await Promise.all([
      supabase.from('api_tokens').select('id, name, last_used_at, revoked_at').order('created_at'),
      supabase.from('cards').select().order('last4'),
    ]);
    if (tokens.data) this.tokens.set(tokens.data);
    if (cards.data) this.cards.set(cards.data);
  }
}
