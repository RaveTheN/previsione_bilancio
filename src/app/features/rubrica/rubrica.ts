import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Ledger } from '../../core/ledger';
import { onlineSignal } from '../../core/online';
import { errorText, InboxName, Merchant, MerchantAlias, supabase } from '../../core/supabase';

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
        <h2>Da assegnare</h2>
        <p class="note">I nomi che arrivano da banca ed estratto. Collegali a un esercente con il nome che vuoi tu.</p>
        <ul>
          @for (i of inbox(); track i.key) {
            <li>
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
        <h2>Esercenti</h2>
        <p class="note">Categoria e secchio valgono subito per i movimenti ancora da assegnare e per quelli nuovi: quelli già assegnati non cambiano.</p>
        <ul>
          @for (m of ledger.merchants(); track m.id) {
            <li>
              <input [value]="m.name" aria-label="Nome dell'esercente" (change)="update(m, { name: value($event) })" />
              <div class="row">
                <select aria-label="Categoria predefinita" (change)="setCategory(m, value($event))">
                  <option value="" [selected]="!m.default_category_id">Nessuna categoria</option>
                  @for (c of categories(); track c.id) {
                    <option [value]="c.id" [selected]="c.id === m.default_category_id">{{ c.name }}</option>
                  }
                </select>
                @if (ledger.categoryById().get(m.default_category_id ?? '')?.kind !== 'income') {
                  <select aria-label="Secchio predefinito" (change)="setBucket(m, value($event))">
                    <option value="" [selected]="!m.default_bucket_id">Nessun secchio</option>
                    @for (b of ledger.buckets(); track b.id) {
                      <option [value]="b.id" [selected]="b.id === m.default_bucket_id">{{ b.name }}</option>
                    }
                  </select>
                }
              </div>
              <div class="aliases">
                @for (a of aliasesOf(m.id); track a.id) {
                  <span class="alias">
                    {{ a.match_type === 'contains' ? 'contiene ' : '' }}{{ a.pattern }}
                    <button type="button" class="icon" [attr.aria-label]="'Scollega ' + a.pattern" (click)="unlink(a)">×</button>
                  </span>
                }
              </div>
            </li>
          } @empty {
            <p class="note">Ancora nessuno: nascono collegando un nome, o assegnando un movimento.</p>
          }
        </ul>
      </section>

      @if (ignored().length) {
        <section>
          <h2>Ignorati</h2>
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
    li {
      display: grid;
      gap: 6px;
      padding: 8px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
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
  protected readonly categories = computed(() => this.ledger.categories().filter((c) => !c.archived));
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

  protected async setCategory(m: Merchant, categoryId: string): Promise<void> {
    // Un'entrata non ha secchio.
    const income = this.ledger.categoryById().get(categoryId)?.kind === 'income';
    const bucketId = income ? null : m.default_bucket_id;
    if (await this.update(m, { default_category_id: categoryId || null, default_bucket_id: bucketId })) {
      await this.applyRule(m, categoryId || null, bucketId);
    }
  }

  protected async setBucket(m: Merchant, bucketId: string): Promise<void> {
    if (await this.update(m, { default_bucket_id: bucketId || null })) {
      await this.applyRule(m, m.default_category_id, bucketId || null);
    }
  }

  /** La regola completa i movimenti dell'esercente ancora da assegnare, senza toccare gli altri. */
  private async applyRule(m: Merchant, categoryId: string | null, bucketId: string | null): Promise<void> {
    if (!categoryId) return;
    const withCategory = await supabase
      .from('transactions')
      .update({ category_id: categoryId })
      .eq('merchant_id', m.id)
      .is('category_id', null)
      .select('id');
    // Poi il secchio, dove manca, sui movimenti di questa categoria (compresi quelli appena aggiornati).
    const withBucket = bucketId
      ? await supabase
          .from('transactions')
          .update({ bucket_id: bucketId })
          .eq('merchant_id', m.id)
          .eq('category_id', categoryId)
          .is('bucket_id', null)
          .select('id')
      : { data: [], error: null, status: 200 };
    const error = withCategory.error ? withCategory : withBucket.error ? withBucket : null;
    if (error) this.snackBar.open('Movimenti non aggiornati: ' + errorText(error), 'OK');
    const n = new Set([...(withCategory.data ?? []), ...(withBucket.data ?? [])].map((r) => r.id)).size;
    if (n) this.snackBar.open(`${m.name}: assegnat${n === 1 ? 'o 1 movimento' : `i ${n} movimenti`}`, 'OK', { duration: 4000 });
    void this.load();
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
