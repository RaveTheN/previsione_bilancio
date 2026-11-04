import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { italianDate } from '../../core/files';
import { todayIso } from '../../core/ledger';
import { formatCents, parseAmount } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, Person, SharedEntry, supabase } from '../../core/supabase';
import { PAGE_STYLES } from '../../shared/page-styles';

/** Chi deve cosa a chi: un registro fuori dal bilancio, che non tocca i movimenti. Solo online. */
@Component({
  selector: 'app-shared-expenses',
  imports: [FormsModule, MatButtonModule],
  template: `
    <h1>Spese condivise</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: le spese condivise si modificano solo con la connessione.</p>
    }
    <p class="note">Un promemoria di chi deve cosa a chi: queste voci non entrano nei totali del bilancio.</p>

    <fieldset [disabled]="!online()">
      @for (p of people(); track p.id) {
        <section class="card" [attr.aria-label]="p.name">
          <div class="line">
            <h2>{{ p.name }}</h2>
            <strong class="num">{{ balanceText(p) }}</strong>
          </div>
          <ul>
            @for (e of open(p); track e.id) {
              <li>
                <div class="line">
                  <span>{{ e.description }}</span>
                  <span class="num">{{ direction(e.amount_cents) }} {{ fmt(abs(e.amount_cents)) }}</span>
                </div>
                <span class="sub">{{ date(e.entry_date) }}</span>
                <div class="actions">
                  <button mat-stroked-button type="button" (click)="setSettled(e, true)">Saldato</button>
                  <button mat-button type="button" (click)="removeEntry(e)">Elimina</button>
                </div>
              </li>
            }
          </ul>
          @if (settled(p).length) {
            <details>
              <summary>Saldate ({{ settled(p).length }})</summary>
              <ul>
                @for (e of settled(p); track e.id) {
                  <li>
                    <div class="line">
                      <span>{{ e.description }}</span>
                      <span class="num">{{ direction(e.amount_cents) }} {{ fmt(abs(e.amount_cents)) }}</span>
                    </div>
                    <span class="sub">{{ date(e.entry_date) }}</span>
                    <div class="actions">
                      <button mat-button type="button" (click)="setSettled(e, false)">Riapri</button>
                      <button mat-button type="button" (click)="removeEntry(e)">Elimina</button>
                    </div>
                  </li>
                }
              </ul>
            </details>
          }
          <div class="actions">
            <button mat-button type="button" (click)="removePerson(p)">Elimina {{ p.name }}</button>
          </div>
        </section>
      } @empty {
        <p class="note">Ancora nessuno.</p>
      }

      <form (ngSubmit)="save()">
        <h2>Nuova voce</h2>
        <label>
          Persona
          <input name="person" list="elenco-persone" autocomplete="off" placeholder="Scegli o scrivi un nome nuovo" [(ngModel)]="personName" />
        </label>
        <datalist id="elenco-persone">
          @for (p of people(); track p.id) {
            <option [value]="p.name"></option>
          }
        </datalist>
        <label>
          Chi deve a chi
          <select name="direction" [(ngModel)]="owedToMe">
            <option [ngValue]="true">Mi deve</option>
            <option [ngValue]="false">Gli devo</option>
          </select>
        </label>
        <label>Per cosa <input name="description" autocomplete="off" placeholder="Es. Internet di novembre" [(ngModel)]="description" /></label>
        <label>Importo (€) <input name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" [(ngModel)]="amountText" /></label>
        <label>Data <input type="date" name="date" [(ngModel)]="entryDate" /></label>
        <div class="actions">
          <button mat-flat-button type="submit">Salva</button>
        </div>
      </form>
    </fieldset>
  `,
  styles: [
    PAGE_STYLES,
    `
      summary {
        display: flex;
        align-items: center;
        min-height: 44px;
        cursor: pointer;
        font: var(--mat-sys-label-large);
      }
    `,
  ],
})
export class SharedExpenses implements OnInit {
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly fmt = formatCents;
  protected readonly date = italianDate;
  protected readonly abs = Math.abs;
  protected readonly people = signal<Person[]>([]);
  private readonly entries = signal<SharedEntry[]>([]);
  private readonly balances = signal<{ person_id: string | null; balance_cents: number | null }[]>([]);
  protected personName = '';
  protected owedToMe = true;
  protected description = '';
  protected amountText = '';
  protected entryDate = todayIso();

  private readonly balanceById = computed(() => new Map(this.balances().map((b) => [b.person_id, b.balance_cents ?? 0])));

  ngOnInit(): void {
    void this.load();
  }

  protected open(p: Person): SharedEntry[] {
    return this.entries().filter((e) => e.person_id === p.id && !e.settled);
  }

  protected settled(p: Person): SharedEntry[] {
    return this.entries().filter((e) => e.person_id === p.id && e.settled);
  }

  protected direction(cents: number): string {
    return cents > 0 ? 'Mi deve' : 'Gli devo';
  }

  protected balanceText(p: Person): string {
    const cents = this.balanceById().get(p.id) ?? 0;
    return cents === 0 ? 'In pari' : `${cents > 0 ? 'Ti deve' : 'Gli devi'} ${formatCents(Math.abs(cents))}`;
  }

  protected async save(): Promise<void> {
    const name = this.personName.trim();
    const amount = parseAmount(this.amountText);
    if (!name || !this.description.trim() || !amount || !this.entryDate) {
      this.snackBar.open('Servono persona, descrizione, importo e data', 'OK', { duration: 5000 });
      return;
    }
    const known = this.people().find((p) => p.name.toLowerCase() === name.toLowerCase());
    const created = known ? null : await supabase.from('people').insert({ name }).select().single();
    if (created?.error) {
      this.done(created, 'Persona non salvata');
      return;
    }
    const res = await supabase.from('shared_entries').insert({
      person_id: known?.id ?? created!.data!.id,
      description: this.description.trim(),
      amount_cents: this.owedToMe ? amount : -amount,
      entry_date: this.entryDate,
    });
    if (!res.error) {
      this.personName = this.description = this.amountText = '';
      this.entryDate = todayIso();
    }
    this.done(res, 'Voce non salvata');
  }

  protected async setSettled(e: SharedEntry, settled: boolean): Promise<void> {
    this.done(await supabase.from('shared_entries').update({ settled }).eq('id', e.id), 'Voce non aggiornata');
  }

  protected async removeEntry(e: SharedEntry): Promise<void> {
    if (!confirm(`Eliminare "${e.description}"?`)) return;
    this.done(await supabase.from('shared_entries').delete().eq('id', e.id), 'Voce non eliminata');
  }

  protected async removePerson(p: Person): Promise<void> {
    const n = this.entries().filter((e) => e.person_id === p.id).length;
    if (!confirm(`Eliminare ${p.name}${n ? ` e le sue ${n} voci` : ''}?`)) return;
    this.done(await supabase.from('people').delete().eq('id', p.id), 'Persona non eliminata');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load();
  }

  private async load(): Promise<void> {
    const [people, entries, balances] = await Promise.all([
      supabase.from('people').select().order('name'),
      supabase.from('shared_entries').select().order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('person_balances').select(),
    ]);
    if (people.data) this.people.set(people.data);
    if (entries.data) this.entries.set(entries.data);
    if (balances.data) this.balances.set(balances.data);
  }
}
