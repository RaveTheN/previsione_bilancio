import { Category, supabase } from './supabase';

type Result = { error: { message: string } | null; status: number };

export interface Group {
  name: string;
  items: Category[];
}

/** Le spese per super categoria, nell'ordine delle categorie come nella torta; senza super categoria vale "Altro". */
export function groupsOf(list: Category[]): Group[] {
  const groups = new Map<string, Category[]>();
  for (const c of list) {
    const name = c.kind === 'expense' ? (c.super_category ?? 'Altro') : '';
    groups.set(name, [...(groups.get(name) ?? []), c]);
  }
  return [...groups].map(([name, items]) => ({ name, items }));
}

/** I gruppi delle spese attive; "Altro" c'è sempre, è dove vanno le spese senza gruppo. */
export function expenseGroupNames(all: Category[]): string[] {
  const names = groupsOf(all.filter((c) => c.kind === 'expense' && !c.archived)).map((g) => g.name);
  return names.includes('Altro') ? names : [...names, 'Altro'];
}

/** sort_order di una categoria nuova: dopo tutte quelle del tipo, cioè in fondo al suo gruppo. */
export function nextOrder(all: Category[], kind: string): number {
  return Math.max(-1, ...all.filter((c) => c.kind === kind).map((c) => c.sort_order)) + 1;
}

/** Le categorie del tipo nell'ordine della pagina Categorie: gruppo per gruppo, poi le archiviate. */
export function pageOrder(all: Category[], kind: string): Category[] {
  const list = all.filter((c) => c.kind === kind);
  return [...groupsOf(list.filter((c) => !c.archived)).flatMap((g) => g.items), ...list.filter((c) => c.archived)];
}

/** Salva l'ordine dato come sort_order 0, 1, 2…, così anche Mese e Anno seguono i gruppi. Scrive solo le righe cambiate. */
export async function saveOrder(list: Category[]): Promise<Result> {
  const changes = list.map((x, order) => ({ x, order })).filter(({ x, order }) => x.sort_order !== order);
  const results = await Promise.all(changes.map(({ x, order }) => supabase.from('categories').update({ sort_order: order }).eq('id', x.id)));
  return results.find((r) => r.error) ?? { error: null, status: 200 };
}
