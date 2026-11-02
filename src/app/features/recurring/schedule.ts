import { shiftMonth } from '../../core/ledger';
import { RecurringRule } from '../../core/supabase';

type Schedule = Pick<RecurringRule, 'frequency' | 'start_date' | 'end_date'>;

/** Scadenza nel mese ("2026-02-01"): il 31 diventa l'ultimo giorno. Come due_in_month nel database. */
export function dueInMonth(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month.slice(0, 7)}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Prima scadenza da oggi in poi; null se la regola è finita. */
export function nextDue(rule: Schedule, today: string): string | null {
  const day = Number(rule.start_date.slice(8, 10));
  const from = rule.start_date > today ? rule.start_date : today;
  let month = from.slice(0, 7) + '-01';
  // Tredici mesi bastano: un'annuale scade al più tardi fra un anno.
  for (let i = 0; i < 13; i++, month = shiftMonth(month, 1)) {
    if (rule.frequency === 'yearly' && month.slice(5, 7) !== rule.start_date.slice(5, 7)) continue;
    const due = dueInMonth(month, day);
    if (due >= from) return rule.end_date && due > rule.end_date ? null : due;
  }
  return null;
}

/** Costo di un anno: un'annuale una volta, una mensile dodici. Con il segno, come i movimenti. */
export function yearlyCost(rule: Pick<RecurringRule, 'frequency' | 'amount_cents'>): number {
  return rule.frequency === 'yearly' ? rule.amount_cents : rule.amount_cents * 12;
}
