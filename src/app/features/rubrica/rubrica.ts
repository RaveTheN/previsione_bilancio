import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute } from '@angular/router';
import { Ledger, monthLabel } from '../../core/ledger';
import { formatCents } from '../../core/money';
import { onlineSignal } from '../../core/online';
import { errorText, InboxName, Merchant, MerchantAlias, supabase } from '../../core/supabase';

/** La spesa di un esercente dai suoi movimenti: totale e mese per mese dal più recente, con le uscite in positivo. */
export function spendByMonth(rows: { month: string | null; amount_cents: number }[]): { total: number; months: { month: string; cents: number }[] } {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.month ?? '', (sums.get(r.month ?? '') ?? 0) - r.amount_cents);
  const months = [...sums].map(([month, cents]) => ({ month, cents })).sort((a, b) => b.month.localeCompare(a.month));
  return { total: months.reduce((s, m) => s + m.cents, 0), months };
}

/** Rubrica: nomi grezzi da collegare a un esercente, ed esercenti con la loro regola. Solo online. */
@Component({
  selector: 'app-rubrica',
  imports: [FormsModule, MatButtonModule],
  template: `
    <h1>Rubrica</h1>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: la Rubrica si modifica solo con la connessione.</p>
    }

    <fieldset [disabled]="!online()">
      <section>
        <h2>Da assegnare · {{ inbox().length }}</h2>
        <p class="note">I nomi che arrivano da banca ed estratto. Collegali a un esercente con il nome che vuoi tu.</p>
        <ul>
          @for (i of inbox(); track i.key) {
            <li class="card">
              <div class="line">
                <span class="text">{{ i.example }}</span>
                <span class="sub">{{ i.n }} mov. · {{ day(i.last_date) }}</span>
              </div>
              @if (open() === i.key) {
                <form class="tool" (ngSubmit)="link(i)">
                  <label>
                    Esercente (esistente o nuovo)
                    <input name="name" list="esercenti" autocomplete="off" required [(ngModel)]="name" />
                  </label>
                  <label class="check">
                    <input type="checkbox" name="contains" [(ngModel)]="contains" />
                    Tutti i nomi che contengono:
                  </label>
                  @if (contains) {
                    <input name="pattern" aria-label="Testo contenuto" [(ngModel)]="pattern" />
                  }
                  <div class="actions">
                    <button mat-button type="button" (click)="open.set(null)">Chiudi</button>
                    <button mat-flat-button type="submit" [disabled]="!name.trim()">Collega</button>
                  </div>
                </form>
              } @else {
                <div class="actions">
                  <button mat-stroked-button type="button" (click)="start(i)">Collega</button>
                  <button mat-button type="button" (click)="ignore(i)">Ignora</button>
                </div>
              }
            </li>
          } @empty {
            <p class="note">Nessun nome da assegnare.</p>
          }
        </ul>
        <datalist id="esercenti">
          @for (m of ledger.merchants(); track m.id) {
            <option [value]="m.name"></option>
          }
        </datalist>
      </section>

      <section>
        <h2>Esercenti · {{ ledger.merchants().length }}</h2>
        <input
          class="search"
          type="search"
          autocomplete="off"
          placeholder="Cerca per nome, riga o nome della banca"
          aria-label="Cerca tra gli esercenti"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
        <details class="help">
          <summary>Come funzionano le regole</summary>
          <p class="note">
            La riga è un nome: ogni movimento va sulla riga con quel nome nel suo mese, se c'è (altrimenti resta da assegnare).
            Vale subito per i movimenti ancora da assegnare e per quelli nuovi; quelli già assegnati non cambiano, e puoi sempre spostarli.
          </p>
          <p class="note">
            Per un esercente che cambia da un acquisto all'altro (es. Amazon, a volte Fun e a volte Fundamentals) scegli «Chiedi ogni volta»:
            ogni suo movimento resta da assegnare finché non scegli tu la riga, e assegnarne uno non tocca gli altri.
          </p>
        </details>
        <datalist id="nomi-righe">
          @for (n of lineNames(); track n) {
            <option [value]="n"></option>
          }
        </datalist>
        <ul>
          @for (m of merchants(); track m.id) {
            <li class="card">
              <!-- Chiuso si legge la regola; aperto si modifica e si vede la spesa. Arrivando dai Grafici con un solo esercente, è già aperto. -->
              <details [open]="!!query().trim() && merchants().length === 1" (toggle)="$any($event.target).open && loadSpend(m.id)">
                <summary>
                  <span class="avatar" aria-hidden="true">{{ m.name.charAt(0).toUpperCase() }}</span>
                  <span class="who">
                    <span class="text">{{ m.name }}</span>
                    <span class="sub" [class.todo]="!m.ask_each_time && !m.default_line_name">{{ rule(m) }}</span>
                  </span>
                </summary>
                <div class="edit">
                  <label>
                    Nome
                    <input [value]="m.name" (change)="update(m, { name: value($event) })" />
                  </label>
                  @if (!m.ask_each_time) {
                    <label>
                      Riga predefinita
                      <input list="nomi-righe" autocomplete="off" placeholder="Es. Benzina" [value]="m.default_line_name ?? ''" (change)="setLine(m, value($event))" />
                    </label>
                  }
                  <label class="check">
                    <input type="checkbox" [checked]="m.ask_each_time" (change)="setAsk(m, $event)" />
                    Chiedi ogni volta (cambia da un acquisto all'altro)
                  </label>
                  @if (aliasesOf(m.id).length) {
                    <span class="sub">Nomi della banca collegati</span>
                    <div class="aliases">
                      @for (a of aliasesOf(m.id); track a.id) {
                        <span class="alias">
                          {{ a.match_type === 'contains' ? 'contiene ' : '' }}{{ a.pattern }}
                          <button type="button" class="icon" [attr.aria-label]="'Scollega ' + a.pattern" (click)="unlink(a)">×</button>
                        </span>
                      }
                    </div>
                  }
                  @if (spend().get(m.id); as s) {
                    <div class="line">
                      <span class="sub">Speso in tutto · {{ s.months.length }} {{ s.months.length === 1 ? 'mese' : 'mesi' }}</span>
                      <strong>{{ fmt(s.total) }}</strong>
                    </div>
                    <ul class="months">
                      @for (x of s.months; track x.month) {
                        <li class="line">
                          <span>{{ label(x.month) }}</span>
                          <span>{{ fmt(x.cents) }}</span>
                        </li>
                      }
                    </ul>
                  }
                  <div class="actions">
                    <button mat-button type="button" [attr.aria-label]="'Elimina ' + m.name" (click)="remove(m)">Elimina</button>
                  </div>
                </div>
              </details>
            </li>
          } @empty {
            <p class="note">
              {{ query().trim() ? 'Nessun esercente trovato.' : 'Ancora nessuno: nascono collegando un nome, o assegnando un movimento.' }}
            </p>
          }
        </ul>
      </section>

      @if (ignored().length) {
        <section>
          <h2>Ignorati</h2>
          <p class="note">Nomi della banca che non sono esercenti: i loro movimenti si assegnano uno per uno.</p>
          <div class="aliases">
            @for (a of ignored(); track a.id) {
              <span class="alias">
                {{ a.pattern }}
                <button type="button" class="icon" [attr.aria-label]="'Non ignorare più ' + a.pattern" (click)="unlink(a)">×</button>
              </span>
            }
          </div>
        </section>
      }
    </fieldset>
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
    h1 {
      margin: 0;
      font: var(--mat-sys-title-large);
    }
    h2 {
      margin: 0 0 4px;
      font: var(--mat-sys-title-medium);
    }
    section {
      display: grid;
      gap: 8px;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    ul {
      display: grid;
      gap: 8px;
    }
    li {
      display: grid;
      gap: 6px;
    }
    .card {
      padding: 8px 12px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    summary {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 48px;
      cursor: pointer;
      list-style: none;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    .help summary {
      font: var(--mat-sys-label-large);
      color: var(--mat-sys-primary);
    }
    .help p + p {
      margin-top: 8px;
    }
    .avatar {
      display: grid;
      flex: none;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
      font: var(--mat-sys-title-small);
    }
    .who {
      display: grid;
      min-width: 0;
    }
    .who .text {
      font: var(--mat-sys-title-small);
    }
    .todo {
      color: var(--mat-sys-tertiary);
    }
    .edit,
    .edit label:not(.check) {
      display: grid;
      gap: 6px;
    }
    .edit {
      gap: 10px;
      padding: 8px 0 4px;
    }
    .edit label {
      font: var(--mat-sys-label-large);
    }
    .line,
    .row,
    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .line {
      justify-content: space-between;
    }
    .actions {
      justify-content: flex-end;
    }
    .months {
      gap: 0;
      font: var(--mat-sys-body-medium);
      font-variant-numeric: tabular-nums;
    }
    .months li {
      display: flex;
      padding: 4px 0;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    .actions button {
      min-height: 44px;
    }
    .text {
      overflow-wrap: anywhere;
    }
    .sub {
      flex: none;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .tool,
    .tool label:not(.check) {
      display: grid;
      gap: 6px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 44px;
    }
    input:not([type='checkbox']),
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
    input.search {
      padding: 0 12px;
      border-radius: 22px;
    }
    .row select {
      flex: 1;
    }
    .aliases {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .alias {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding-left: 10px;
      border-radius: 16px;
      background: var(--mat-sys-surface-container-high);
      font: var(--mat-sys-label-medium);
    }
    .icon {
      min-width: 44px;
      min-height: 44px;
      border: 0;
      background: none;
      color: inherit;
      font: var(--mat-sys-title-medium);
      cursor: pointer;
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
export class Rubrica implements OnInit {
  protected readonly ledger = inject(Ledger);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly inbox = signal<InboxName[]>([]);
  private readonly aliases = signal<MerchantAlias[]>([]);
  protected readonly ignored = computed(() => this.aliases().filter((a) => a.ignored));
  /** Suggerimenti: i nomi delle righe del mese aperto e quelli già usati dalle regole. */
  protected readonly lineNames = computed(() =>
    [...new Set([...this.ledger.lines().map((l) => l.name), ...this.ledger.merchants().flatMap((m) => m.default_line_name ?? [])])].sort(),
  );
  /** Dai Grafici si arriva con il nome dell'esercente già cercato. */
  protected readonly query = signal(inject(ActivatedRoute).snapshot.queryParamMap.get('cerca') ?? '');
  protected readonly fmt = formatCents;
  protected readonly label = monthLabel;
  /** La spesa degli esercenti aperti, letta quando si apre la scheda. */
  protected readonly spend = signal(new Map<string, ReturnType<typeof spendByMonth>>());
  /** Gli esercenti che contengono il testo cercato nel nome, nella riga o in un nome della banca collegato. */
  protected readonly merchants = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.ledger.merchants();
    const has = (text: string | null) => !!text?.toLowerCase().includes(q);
    const byAlias = new Set(this.aliases().filter((a) => has(a.pattern)).map((a) => a.merchant_id));
    return this.ledger.merchants().filter((m) => has(m.name) || has(m.default_line_name) || byAlias.has(m.id));
  });
  protected readonly open = signal<string | null>(null);
  protected name = '';
  protected contains = false;
  protected pattern = '';

  ngOnInit(): void {
    void this.load();
  }

  protected value(e: Event): string {
    return (e.target as HTMLInputElement).value.trim();
  }

  protected day(date: string | null): string {
    return date ? new Date(date + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';
  }

  protected async loadSpend(merchantId: string): Promise<void> {
    // shortcut: al massimo 1000 movimenti per esercente (il limite dell'API); oltre, la somma va fatta nel database.
    const res = await supabase.from('transactions').select('month, amount_cents').eq('merchant_id', merchantId).neq('status', 'declined');
    if (res.data) this.spend.update((old) => new Map(old).set(merchantId, spendByMonth(res.data)));
  }

  protected rule(m: Merchant): string {
    return m.ask_each_time ? 'Chiedi ogni volta' : m.default_line_name ? '→ ' + m.default_line_name : 'Nessuna riga: i movimenti restano da assegnare';
  }

  protected aliasesOf(merchantId: string): MerchantAlias[] {
    return this.aliases().filter((a) => a.merchant_id === merchantId);
  }

  protected start(i: InboxName): void {
    this.open.set(i.key);
    this.name = '';
    this.contains = false;
    this.pattern = i.key ?? '';
  }

  protected async link(i: InboxName): Promise<void> {
    const res = await supabase.rpc('link_alias', {
      p_pattern: this.contains ? this.pattern : (i.key ?? ''),
      p_contains: this.contains,
      p_name: this.name,
    });
    if (!res.error) {
      this.open.set(null);
      this.snackBar.open(`Collegati ${res.data} movimenti a ${this.name.trim()}`, 'OK', { duration: 4000 });
    }
    this.done(res, 'Non collegato');
  }

  protected async ignore(i: InboxName): Promise<void> {
    this.done(await supabase.from('merchant_aliases').insert({ pattern: i.key ?? '', ignored: true }), 'Non salvato');
  }

  protected async unlink(a: MerchantAlias): Promise<void> {
    this.done(await supabase.from('merchant_aliases').delete().eq('id', a.id), 'Non salvato');
  }

  /** La regola assegna subito i movimenti dell'esercente ancora da assegnare, senza toccare gli altri. */
  protected async setLine(m: Merchant, name: string): Promise<void> {
    if (!(await this.update(m, { default_line_name: name || null })) || !name) return;
    const res = await supabase.rpc('apply_merchant_rule', { p_merchant_id: m.id });
    if (res.error) this.snackBar.open('Movimenti non aggiornati: ' + errorText(res), 'OK');
    const n = res.data ?? 0;
    if (n) this.snackBar.open(`${m.name}: assegnat${n === 1 ? 'o 1 movimento' : `i ${n} movimenti`}`, 'OK', { duration: 4000 });
    void this.ledger.load();
  }

  /** I movimenti restano sulla loro riga, senza esercente; i suoi nomi (alias) spariscono con lui. */
  protected async remove(m: Merchant): Promise<void> {
    const text = `Eliminare ${m.name}? I suoi movimenti restano sulla loro riga; i nomi della banca tornano in Da assegnare.`;
    if (!confirm(text)) return;
    this.done(await supabase.from('merchants').delete().eq('id', m.id), 'Esercente non eliminato');
  }

  /** Chiedi ogni volta: la regola perde la riga. */
  protected setAsk(m: Merchant, e: Event): void {
    const ask = (e.target as HTMLInputElement).checked;
    void this.update(m, ask ? { ask_each_time: true, default_line_name: null } : { ask_each_time: false });
  }

  protected async update(m: Merchant, patch: Partial<Merchant>): Promise<boolean> {
    const res = await supabase.from('merchants').update(patch).eq('id', m.id);
    this.done(res, res.error?.code === '23505' ? 'Esiste già un esercente con questo nome' : 'Non salvato');
    return !res.error;
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.load();
  }

  private async load(): Promise<void> {
    const [inbox, aliases] = await Promise.all([
      supabase.from('merchant_inbox').select().order('n', { ascending: false }),
      supabase.from('merchant_aliases').select().order('pattern'),
    ]);
    if (inbox.data) this.inbox.set(inbox.data);
    if (aliases.data) this.aliases.set(aliases.data);
    void this.ledger.load();
  }
}
