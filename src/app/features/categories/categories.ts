import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Ledger } from '../../core/ledger';
import { onlineSignal } from '../../core/online';
import { Category, errorText, supabase } from '../../core/supabase';
import { PAGE_STYLES } from '../../shared/page-styles';

const KINDS = [
  { value: 'expense', label: 'Spese' },
  { value: 'income', label: 'Entrate' },
  { value: 'saving', label: 'Risparmio' },
] as const;

type Group = { name: string; items: Category[] };

/** Le spese per super categoria, nell'ordine delle categorie come nella torta; senza super categoria vale "Altro". */
export function groupsOf(list: Category[]): Group[] {
  const groups = new Map<string, Category[]>();
  for (const c of list) {
    const name = c.kind === 'expense' ? (c.super_category ?? 'Altro') : '';
    groups.set(name, [...(groups.get(name) ?? []), c]);
  }
  return [...groups].map(([name, items]) => ({ name, items }));
}

/** Categorie: le voci del bilancio, raggruppate come nella torta. Solo online. */
@Component({
  selector: 'app-categories',
  imports: [FormsModule, MatButtonModule],
  template: `
    <h1>Categorie</h1>
    <p class="note">
      Ogni categoria è una voce del bilancio, con previsto ed effettivo in Mese e Anno. Le spese stanno in gruppi, gli stessi della torta dei
      Grafici. Il secchio non dipende dalla categoria: lo scegli su ogni movimento.
    </p>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: le categorie si modificano solo con la connessione.</p>
    }

    <fieldset [disabled]="!online()">
      @for (k of sections(); track k.value) {
        <section>
          <h2>{{ k.label }}</h2>
          @for (g of k.groups; track g.name) {
            @if (g.name) {
              <h3>{{ g.name }}</h3>
            }
            <ul>
              @for (c of g.items; track c.id; let first = $first, last = $last) {
                <li>
                  <details>
                    <summary>
                      <span>{{ c.name }}</span>
                      <svg viewBox="0 -960 960 960" aria-hidden="true">
                        <path
                          d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"
                        />
                      </svg>
                    </summary>
                    <div class="edit">
                      <label>Nome <input autocomplete="off" [value]="c.name" (change)="rename(c, $event)" /></label>
                      @if (c.kind === 'expense') {
                        <label>
                          Gruppo
                          <input list="gruppi" autocomplete="off" placeholder="Altro" [value]="c.super_category ?? ''" (change)="setGroup(c, value($event))" />
                        </label>
                      }
                      <div class="actions">
                        <button type="button" class="icon" [attr.aria-label]="'Sposta su ' + c.name" [disabled]="first" (click)="move(c, -1)">
                          <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M440-160v-487L216-423l-56-57 320-320 320 320-56 57-224-224v487h-80Z" /></svg>
                        </button>
                        <button type="button" class="icon" [attr.aria-label]="'Sposta giù ' + c.name" [disabled]="last" (click)="move(c, 1)">
                          <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487h-80Z" /></svg>
                        </button>
                        <button mat-button type="button" (click)="update(c, { archived: true })">Archivia</button>
                      </div>
                    </div>
                  </details>
                </li>
              }
            </ul>
          }
        </section>
      }

      <form (ngSubmit)="add()">
        <h2>Nuova categoria</h2>
        <label>Nome <input name="name" autocomplete="off" placeholder="Es. Abbonamento Claude" [(ngModel)]="name" /></label>
        <label>
          Tipo
          <select name="kind" [(ngModel)]="kind">
            @for (k of kinds; track k.value) {
              <option [value]="k.value">{{ k.label }}</option>
            }
          </select>
        </label>
        @if (kind === 'expense') {
          <label>Gruppo <input name="group" list="gruppi" autocomplete="off" placeholder="Es. Abbonamenti (vuoto = Altro)" [(ngModel)]="group" /></label>
        }
        <div class="actions">
          <button mat-flat-button type="submit" [disabled]="!name.trim()">Aggiungi</button>
        </div>
      </form>

      @if (archived().length) {
        <details class="archived">
          <summary>Archiviate ({{ archived().length }})</summary>
          <p class="note">Non compaiono nell'inserimento rapido né tra le previsioni; restano nei mesi passati.</p>
          <ul>
            @for (c of archived(); track c.id) {
              <li class="line">
                <span>{{ c.name }}</span>
                <button mat-button type="button" (click)="update(c, { archived: false })">Ripristina</button>
              </li>
            }
          </ul>
        </details>
      }
    </fieldset>

    <datalist id="gruppi">
      @for (name of groupNames(); track name) {
        <option [value]="name"></option>
      }
    </datalist>
  `,
  styles: [
    PAGE_STYLES,
    `
      h3 {
        margin: 12px 0 0;
        font: var(--mat-sys-title-small);
        color: var(--mat-sys-on-surface-variant);
      }
      li {
        padding: 0;
      }
      summary {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        min-height: 48px;
        list-style: none;
        cursor: pointer;
      }
      summary::-webkit-details-marker {
        display: none;
      }
      details[open] > summary {
        font-weight: 500;
      }
      svg {
        flex: none;
        width: 20px;
        height: 20px;
        fill: currentColor;
      }
      summary svg {
        color: var(--mat-sys-on-surface-variant);
      }
      .edit {
        display: grid;
        gap: 12px;
        padding-bottom: 12px;
      }
      .edit .actions {
        align-items: center;
      }
      .icon {
        display: grid;
        place-items: center;
        width: 44px;
        border: 0;
        background: none;
        color: var(--mat-sys-on-surface);
        cursor: pointer;
      }
      .icon:disabled {
        opacity: 0.3;
      }
      .archived > summary {
        font: var(--mat-sys-title-medium);
      }
    `,
  ],
})
export class Categories {
  private readonly ledger = inject(Ledger);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly online = onlineSignal();
  protected readonly kinds = KINDS;
  protected name = '';
  protected kind: Category['kind'] = 'expense';
  protected group = '';

  protected readonly sections = computed(() =>
    KINDS.map((k) => ({ ...k, groups: groupsOf(this.ledger.categories().filter((c) => c.kind === k.value && !c.archived)) })),
  );
  protected readonly archived = computed(() => this.ledger.categories().filter((c) => c.archived));
  protected readonly groupNames = computed(() =>
    [...new Set(['Altro', ...this.ledger.categories().flatMap((c) => c.super_category ?? [])])].sort(),
  );

  protected value(e: Event): string {
    return (e.target as HTMLInputElement).value.trim();
  }

  protected async update(c: Category, patch: Partial<Category>): Promise<void> {
    const res = await supabase.from('categories').update(patch).eq('id', c.id);
    this.done(res, res.error?.code === '23505' ? 'Esiste già una categoria con questo nome' : 'Modifica non salvata');
  }

  /** Un nome vuoto non si salva: il campo torna com'era. */
  protected rename(c: Category, e: Event): void {
    const input = e.target as HTMLInputElement;
    const name = input.value.trim();
    if (name) void this.update(c, { name });
    else input.value = c.name;
  }

  /** La voce va in fondo al nuovo gruppo. */
  protected async setGroup(c: Category, name: string): Promise<void> {
    const res = await supabase.from('categories').update({ super_category: name || null, sort_order: this.nextOrder(c.kind) }).eq('id', c.id);
    await this.afterChange(res, c.kind, 'Gruppo non salvato');
  }

  protected async add(): Promise<void> {
    const name = this.name.trim();
    const res = await supabase.from('categories').insert({
      name,
      kind: this.kind,
      super_category: this.kind === 'expense' ? this.group.trim() || null : null,
      sort_order: this.nextOrder(this.kind),
    });
    if (!res.error) this.name = this.group = '';
    await this.afterChange(res, this.kind, res.error?.code === '23505' ? 'Esiste già una categoria con questo nome' : 'Categoria non aggiunta');
  }

  /** Scambia con la vicina dello stesso gruppo. */
  protected async move(c: Category, delta: number): Promise<void> {
    const list = this.flat(c.kind);
    const i = list.indexOf(c);
    [list[i], list[i + delta]] = [list[i + delta], list[i]];
    await this.renumber(list);
  }

  private nextOrder(kind: string): number {
    return Math.max(-1, ...this.ledger.categories().filter((c) => c.kind === kind).map((c) => c.sort_order)) + 1;
  }

  /** Le categorie del tipo nell'ordine della pagina: gruppo per gruppo, poi le archiviate. */
  private flat(kind: string): Category[] {
    const list = this.ledger.categories().filter((c) => c.kind === kind);
    return [...groupsOf(list.filter((c) => !c.archived)).flatMap((g) => g.items), ...list.filter((c) => c.archived)];
  }

  /** Dopo un cambio di gruppo, rinumera: così anche le righe di Mese e Anno seguono i gruppi. */
  private async afterChange(res: { error: { message: string } | null; status: number }, kind: string, message: string): Promise<void> {
    if (res.error) return this.done(res, message);
    await this.ledger.load();
    await this.renumber(this.flat(kind));
  }

  private async renumber(list: Category[]): Promise<void> {
    const changes = list.map((x, order) => ({ x, order })).filter(({ x, order }) => x.sort_order !== order);
    const results = await Promise.all(changes.map(({ x, order }) => supabase.from('categories').update({ sort_order: order }).eq('id', x.id)));
    this.done(results.find((r) => r.error) ?? { error: null, status: 200 }, 'Ordine non salvato');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.ledger.load();
  }
}
