import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { expenseGroupNames, Group, groupsOf, nextOrder, pageOrder, saveOrder } from '../../core/category-order';
import { Ledger } from '../../core/ledger';
import { onlineSignal } from '../../core/online';
import { Category, errorText, supabase } from '../../core/supabase';
import { PAGE_STYLES } from '../../shared/page-styles';

/** Un riquadro della pagina: un gruppo di spese, oppure Entrate o Risparmio. */
interface Card extends Group {
  kind: Category['kind'];
  /** Gruppo di spese: si rinomina e si sposta. */
  group: boolean;
  index: number;
  canUp: boolean;
  canDown: boolean;
}

const UP = 'M440-160v-487L216-423l-56-57 320-320 320 320-56 57-224-224v487h-80Z';
const DOWN = 'M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487h-80Z';
const EDIT =
  'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z';

/** Categorie: i gruppi delle spese (gli stessi della torta) e le loro categorie. Solo online. */
@Component({
  selector: 'app-categories',
  imports: [FormsModule, MatButtonModule],
  template: `
    <h1>Categorie</h1>
    <p class="note">
      Ogni categoria ha la sua riga di previsto ed effettivo in Mese e Anno, nell'ordine di questa pagina. Il secchio non dipende dalla
      categoria: lo scegli su ogni movimento.
    </p>
    @if (!online()) {
      <p class="warn" role="status">Sei offline: le categorie si modificano solo con la connessione.</p>
    }

    <fieldset [disabled]="!online()">
      @for (s of sections(); track s.title) {
        <section>
          <h2>{{ s.title }}</h2>
          @if (s.note) {
            <p class="note">{{ s.note }}</p>
          }
          <div class="cards">
            @for (card of s.cards; track card.kind + card.name) {
              <article class="card" [attr.aria-label]="card.name">
                @if (renaming() === card.name && card.group) {
                  <form class="head" (ngSubmit)="renameGroup(card)">
                    <input name="rename" autocomplete="off" aria-label="Nuovo nome del gruppo" required [(ngModel)]="renameText" />
                    <button mat-flat-button type="submit">Salva</button>
                    <button mat-button type="button" (click)="renaming.set(null)">Annulla</button>
                  </form>
                } @else {
                  <div class="head">
                    <h3>{{ card.name }}</h3>
                    @if (card.group) {
                      <button type="button" class="icon" [attr.aria-label]="'Sposta prima il gruppo ' + card.name" [disabled]="!card.canUp" (click)="moveGroup(card.index, -1)">
                        <svg viewBox="0 -960 960 960" aria-hidden="true"><path [attr.d]="icons.up" /></svg>
                      </button>
                      <button type="button" class="icon" [attr.aria-label]="'Sposta dopo il gruppo ' + card.name" [disabled]="!card.canDown" (click)="moveGroup(card.index, 1)">
                        <svg viewBox="0 -960 960 960" aria-hidden="true"><path [attr.d]="icons.down" /></svg>
                      </button>
                      <button type="button" class="icon" [attr.aria-label]="'Rinomina il gruppo ' + card.name" (click)="startRename(card)">
                        <svg viewBox="0 -960 960 960" aria-hidden="true"><path [attr.d]="icons.edit" /></svg>
                      </button>
                    }
                  </div>
                }

                <ul>
                  @for (c of card.items; track c.id; let first = $first, last = $last) {
                    <li>
                      <details>
                        <summary>
                          <span>{{ c.name }}</span>
                          <svg viewBox="0 -960 960 960" aria-hidden="true"><path [attr.d]="icons.edit" /></svg>
                        </summary>
                        <div class="edit">
                          <label>Nome <input autocomplete="off" [value]="c.name" (change)="rename(c, $event)" /></label>
                          @if (card.group) {
                            <label>
                              Gruppo
                              <select (change)="setGroup(c, value($event))">
                                @for (n of groupNames(); track n) {
                                  <option [value]="n" [selected]="n === card.name">{{ n }}</option>
                                }
                              </select>
                            </label>
                          }
                          <div class="actions">
                            <button type="button" class="icon" [attr.aria-label]="'Sposta su ' + c.name" [disabled]="first" (click)="move(c, -1)">
                              <svg viewBox="0 -960 960 960" aria-hidden="true"><path [attr.d]="icons.up" /></svg>
                            </button>
                            <button type="button" class="icon" [attr.aria-label]="'Sposta giù ' + c.name" [disabled]="last" (click)="move(c, 1)">
                              <svg viewBox="0 -960 960 960" aria-hidden="true"><path [attr.d]="icons.down" /></svg>
                            </button>
                            <button mat-button type="button" (click)="update(c, { archived: true })">Archivia</button>
                          </div>
                        </div>
                      </details>
                    </li>
                  }
                </ul>
                @if (!card.items.length) {
                  <p class="note">Gruppo vuoto: aggiungi una categoria qui sotto, o spostane qui una esistente scegliendo questo gruppo. Senza categorie non viene salvato.</p>
                  <div class="actions">
                    <button mat-button type="button" (click)="dropGroup(card.name)">Elimina il gruppo</button>
                  </div>
                }

                <form class="add" (ngSubmit)="add(card, newName)">
                  <input #newName autocomplete="off" [attr.aria-label]="'Nuova categoria in ' + card.name" [placeholder]="'Nuova categoria in ' + card.name" />
                  <button mat-stroked-button type="submit">Aggiungi</button>
                </form>
              </article>
            }

            @if (s.kind === 'expense') {
              <form class="card new" (ngSubmit)="addGroup(groupName)">
                <h3>Nuovo gruppo</h3>
                <p class="note">Es. Abbonamenti. Poi aggiungi o sposta le categorie nel suo riquadro.</p>
                <div class="add">
                  <input #groupName autocomplete="off" aria-label="Nome del nuovo gruppo" placeholder="Nome del gruppo" />
                  <button mat-flat-button type="submit">Crea</button>
                </div>
              </form>
            }
          </div>
        </section>
      }

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
  `,
  styles: [
    PAGE_STYLES,
    `
      section {
        display: grid;
        gap: 8px;
      }
      /* Riquadri affiancati quando c'è spazio, uno sotto l'altro su telefono. */
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
        align-items: start;
        gap: 12px;
      }
      .card {
        gap: 8px;
      }
      .new {
        border: 1px dashed var(--mat-sys-outline);
        background: none;
      }
      h3 {
        flex: 1;
        margin: 0;
        font: var(--mat-sys-title-medium);
      }
      .head,
      .add {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .head input,
      .add input {
        flex: 1;
      }
      .add {
        gap: 8px;
      }
      li {
        padding: 0;
      }
      summary {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        min-height: 44px;
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
  protected readonly icons = { up: UP, down: DOWN, edit: EDIT };
  /** Gruppi appena creati e ancora vuoti: esistono solo qui finché non ricevono una categoria. */
  private readonly pending = signal<string[]>([]);
  protected readonly renaming = signal<string | null>(null);
  protected renameText = '';

  private readonly active = computed(() => this.ledger.categories().filter((c) => !c.archived));
  private readonly expenseGroups = computed(() => groupsOf(this.active().filter((c) => c.kind === 'expense')));

  /** I gruppi salvati, poi quelli appena creati (vuoti, non si spostano). */
  private readonly groupCards = computed<Card[]>(() => {
    const saved = this.expenseGroups();
    const empty = this.pending().filter((n) => !saved.some((g) => g.name === n));
    return [...saved, ...empty.map((name) => ({ name, items: [] }))].map((g, i) => ({
      ...g,
      kind: 'expense',
      group: true,
      index: i,
      canUp: i > 0 && i < saved.length,
      canDown: i < saved.length - 1,
    }));
  });

  protected readonly sections = computed(() => {
    const fixed = (name: string, kind: Category['kind']): Card => ({
      name,
      kind,
      items: this.active().filter((c) => c.kind === kind),
      group: false,
      index: 0,
      canUp: false,
      canDown: false,
    });
    return [
      { title: 'Spese', kind: 'expense', note: 'I gruppi sono gli stessi della torta nei Grafici.', cards: this.groupCards() },
      { title: 'Entrate e risparmio', kind: 'income', note: '', cards: [fixed('Entrate', 'income'), fixed('Risparmio', 'saving')] },
    ];
  });

  /** I gruppi tra cui spostare una spesa, compresi quelli appena creati. */
  protected readonly groupNames = computed(() => [...new Set([...this.groupCards().map((c) => c.name), ...expenseGroupNames(this.ledger.categories())])]);

  protected readonly archived = computed(() => this.ledger.categories().filter((c) => c.archived));

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

  /** La categoria va in fondo al gruppo scelto. */
  protected async setGroup(c: Category, name: string): Promise<void> {
    const res = await supabase.from('categories').update({ super_category: name, sort_order: nextOrder(this.ledger.categories(), c.kind) }).eq('id', c.id);
    await this.afterChange(res, c.kind, name, 'Gruppo non salvato');
  }

  protected async add(card: Card, input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (!name) return;
    const res = await supabase.from('categories').insert({
      name,
      kind: card.kind,
      super_category: card.group ? card.name : null,
      sort_order: nextOrder(this.ledger.categories(), card.kind),
    });
    if (!res.error) input.value = '';
    await this.afterChange(res, card.kind, card.name, res.error?.code === '23505' ? 'Esiste già una categoria con questo nome' : 'Categoria non aggiunta');
  }

  protected addGroup(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) return;
    if (this.groupNames().some((n) => n.toLowerCase() === name.toLowerCase())) {
      this.snackBar.open(`Il gruppo ${name} esiste già`, 'OK', { duration: 4000 });
      return;
    }
    this.pending.update((p) => [...p, name]);
    input.value = '';
  }

  protected dropGroup(name: string): void {
    this.pending.update((p) => p.filter((n) => n !== name));
  }

  protected startRename(card: Card): void {
    this.renameText = card.name;
    this.renaming.set(card.name);
  }

  /** Rinomina il gruppo su tutte le sue categorie, anche le archiviate; con il nome di un altro gruppo li unisce. */
  protected async renameGroup(card: Card): Promise<void> {
    const name = this.renameText.trim();
    if (!name || name === card.name) return this.renaming.set(null);
    if (!card.items.length) {
      this.pending.update((p) => p.map((n) => (n === card.name ? name : n)));
      return this.renaming.set(null);
    }
    const ids = this.ledger
      .categories()
      .filter((c) => c.kind === 'expense' && (c.super_category ?? 'Altro') === card.name)
      .map((c) => c.id);
    const res = await supabase.from('categories').update({ super_category: name }).in('id', ids);
    if (!res.error) this.renaming.set(null);
    this.done(res, 'Gruppo non rinominato');
  }

  /** Scambia il gruppo con il vicino: le categorie dei due gruppi si rinumerano in blocco. */
  protected async moveGroup(i: number, delta: number): Promise<void> {
    const groups = [...this.expenseGroups()];
    [groups[i], groups[i + delta]] = [groups[i + delta], groups[i]];
    const archived = this.ledger.categories().filter((c) => c.kind === 'expense' && c.archived);
    await this.renumber([...groups.flatMap((g) => g.items), ...archived]);
  }

  /** Scambia con la vicina dello stesso gruppo. */
  protected async move(c: Category, delta: number): Promise<void> {
    const list = pageOrder(this.ledger.categories(), c.kind);
    const i = list.indexOf(c);
    [list[i], list[i + delta]] = [list[i + delta], list[i]];
    await this.renumber(list);
  }

  /** Dopo un cambio di gruppo, rinumera: così anche le righe di Mese e Anno seguono i gruppi. */
  private async afterChange(res: { error: { message: string } | null; status: number }, kind: string, group: string, message: string): Promise<void> {
    if (res.error) return this.done(res, message);
    // Il gruppo ora ha una categoria: è salvato, non serve più tenerlo in sospeso.
    this.pending.update((p) => p.filter((n) => n !== group));
    await this.ledger.load();
    await this.renumber(pageOrder(this.ledger.categories(), kind));
  }

  private async renumber(list: Category[]): Promise<void> {
    this.done(await saveOrder(list), 'Ordine non salvato');
  }

  private done(res: { error: { message: string } | null; status: number }, message: string): void {
    if (res.error) this.snackBar.open(`${message}: ${errorText(res)}`, 'OK');
    void this.ledger.load();
  }
}
