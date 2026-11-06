import { Category } from '../../core/supabase';
import { groupsOf } from './categories';

const cat = (name: string, kind: string, super_category: string | null) => ({ id: name, name, kind, super_category }) as Category;

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
});
