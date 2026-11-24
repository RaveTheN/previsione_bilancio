import { Transaction } from '../../core/supabase';

/** Un movimento contabilizzato dalla banca, come lo restituisce la funzione "banca". */
export interface BankRow {
  ref: string;
  amount_cents: number;
  booking_date: string;
  /** Il giorno dell'acquisto: è quello che l'app registra dalla notifica. */
  value_date: string;
  kind: string;
  text: string;
}

export interface Reconciled {
  /** In banca ma non nell'app. */
  missing: BankRow[];
  /** Nell'app ma non in banca, dopo il tempo che la banca si prende per contabilizzare. */
  unknown: Transaction[];
  /** Nell'app da pochi giorni: la banca può non averli ancora contabilizzati. */
  waiting: number;
}

/** La banca contabilizza un pagamento fino a qualche giorno dopo (fine settimana compreso). */
export const BOOKING_LAG = 4;

const day = (iso: string) => Date.parse(iso + 'T00:00:00Z') / 86400e3;

/**
 * Abbina i movimenti della banca a quelli dell'app sullo stesso conto, uno a uno: stesso importo
 * e giorno vicino, come private.import_statement. Le parti di un movimento diviso contano insieme.
 * `from` è il primo giorno chiesto alla banca: prima di allora un movimento dell'app non si giudica.
 */
export function reconcile(bank: BankRow[], app: Transaction[], from: string, today: string): Reconciled {
  const units = new Map<string, { rows: Transaction[]; amount: number; day: number }>();
  for (const t of app) {
    if (t.status === 'declined') continue;
    const key = t.split_group_id ?? t.id;
    const unit = units.get(key) ?? { rows: [], amount: 0, day: day(t.booking_date) };
    unit.rows.push(t);
    unit.amount += t.amount_cents;
    units.set(key, unit);
  }

  // Prima le coppie dello stesso giorno, poi quelle via via più lontane: tra due pagamenti uguali
  // in giorni vicini ognuno prende il suo, e resta scoperto quello giusto.
  const matched = new Set<string>();
  for (let gap = 0; gap <= 13; gap++) {
    for (const b of bank) {
      if (matched.has(b.ref)) continue;
      const bought = Math.min(day(b.value_date), day(b.booking_date));
      // PayPal avvisa del pagamento molto prima dell'addebito sul conto.
      const back = /paypal/i.test(b.text) ? 10 : 3;
      for (const [key, u] of units) {
        if (u.amount !== b.amount_cents || Math.abs(u.day - bought) !== gap) continue;
        if (u.day < bought - back || u.day > day(b.booking_date) + 3) continue;
        units.delete(key);
        matched.add(b.ref);
        break;
      }
    }
  }

  const left = [...units.values()].filter((u) => u.day >= day(from));
  const settled = (u: { day: number }) => u.day <= day(today) - BOOKING_LAG;
  return {
    missing: bank.filter((b) => !matched.has(b.ref)).sort((x, y) => y.booking_date.localeCompare(x.booking_date)),
    unknown: left.filter(settled).flatMap((u) => u.rows).sort((x, y) => y.booking_date.localeCompare(x.booking_date)),
    waiting: left.filter((u) => !settled(u)).length,
  };
}
