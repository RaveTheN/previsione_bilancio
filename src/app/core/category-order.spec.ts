import { expenseGroupNames, groupsOf, orderWithoutGroup, pageOrder } from './category-order';
import { Category } from './supabase';

const cat = (name: string, kind: string, super_category: string | null, sort_order = 0, archived = false) =>
  ({ id: name, name, kind, super_category, sort_order, archived }) as Category;

describe('gruppi delle categorie', () => {
  it('nell\'ordine della prima voce; senza super categoria vale "Altro"', () => {
    const groups = groupsOf([cat('Affitto', 'expense', 'Casa'), cat('Regali', 'expense', null), cat('Utenze', 'expense', 'Casa'), cat('Cinema', 'expense', 'Altro')]);
    expect(groups.map((g) => [g.name, g.items.map((c) => c.name)])).toEqual([
      ['Casa', ['Affitto', 'Utenze']],
      ['Altro', ['Regali', 'Cinema']],
    ]);
  });

  it('entrate e risparmio in un solo gruppo senza nome', () => {
    expect(groupsOf([cat('Stipendio', 'income', 'Casa'), cat('Vinted', 'income', null)]).map((g) => g.name)).toEqual(['']);
  });

  it('una categoria nuova in fondo al tipo finisce in fondo al suo gruppo; le archiviate per ultime', () => {
    const all = [cat('Affitto', 'expense', 'Casa'), cat('Vecchia', 'expense', 'Casa', 0, true), cat('Regali', 'expense', null), cat('Garage', 'expense', 'Casa'), cat('Vinted', 'income', null)];
    expect(pageOrder(all, 'expense').map((c) => c.name)).toEqual(['Affitto', 'Garage', 'Regali', 'Vecchia']);
  });

  it('eliminare un gruppo: le sue categorie in fondo ad Altro, che resta al suo posto', () => {
    const all = [cat('Affitto', 'expense', 'Casa', 0), cat('Regali', 'expense', null, 1), cat('Cinema', 'expense', 'Svago', 2)];
    expect(orderWithoutGroup(all, 'Casa').map((c) => c.name)).toEqual(['Regali', 'Affitto', 'Cinema']);
    // Senza un gruppo Altro, nasce in fondo.
    expect(orderWithoutGroup([all[0], all[2]], 'Casa').map((c) => c.name)).toEqual(['Cinema', 'Affitto']);
  });

  it('per scegliere il gruppo: quelli delle spese attive, più "Altro"', () => {
    expect(expenseGroupNames([cat('Affitto', 'expense', 'Casa'), cat('Vecchia', 'expense', 'Passato', 0, true)])).toEqual(['Casa', 'Altro']);
  });
});
