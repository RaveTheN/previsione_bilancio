import { Transaction } from '../../core/supabase';
import { BankRow, reconcile } from './reconcile';

const bank = (ref: string, amount_cents: number, value_date: string, booking_date = value_date, text = 'SUPERMERCATO'): BankRow => ({
  ref,
  amount_cents,
  value_date,
  booking_date,
  kind: 'PAGO CON TARJETA',
  text,
});
const app = (id: string, amount_cents: number, booking_date: string, extra: Partial<Transaction> = {}) =>
  ({ id, amount_cents, booking_date, status: 'confirmed', split_group_id: null, ...extra }) as Transaction;

describe('confronto con la banca', () => {
  const from = '2026-11-10';
  const today = '2026-11-24';

  it('abbina per importo e giorno vicino, anche se la banca contabilizza dopo il fine settimana', () => {
    const r = reconcile([bank('a', -600, '2026-11-21', '2026-11-23')], [app('1', -600, '2026-11-21')], from, today);
    expect(r).toEqual({ missing: [], unknown: [], waiting: 0 });
  });

  it('due pagamenti uguali restano due: il secondo della banca manca nell\'app', () => {
    const r = reconcile([bank('a', -600, '2026-11-18'), bank('b', -600, '2026-11-19')], [app('1', -600, '2026-11-19')], from, today);
    expect(r.missing.map((b) => b.ref)).toEqual(['a']);
  });

  it('un movimento dell\'app senza riscontro è sospetto solo dopo qualche giorno', () => {
    const r = reconcile([], [app('vecchio', -500, '2026-11-15'), app('nuovo', -700, '2026-11-23'), app('prima', -900, '2026-11-05')], from, today);
    expect(r.unknown.map((t) => t.id)).toEqual(['vecchio']);
    expect(r.waiting).toBe(1);
  });

  it('le parti di un movimento diviso contano insieme; i rifiutati non contano', () => {
    const rows = [
      app('p1', -400, '2026-11-18', { split_group_id: 'g' }),
      app('p2', -600, '2026-11-18', { split_group_id: 'g' }),
      app('no', -1000, '2026-11-18', { status: 'declined' }),
    ];
    expect(reconcile([bank('a', -1000, '2026-11-18')], rows, from, today)).toEqual({ missing: [], unknown: [], waiting: 0 });
  });

  it('un accredito della banca inserito nell\'app come due movimenti è abbinato alla loro somma', () => {
    const r = reconcile([bank('a', 8900, '2026-11-18')], [app('1', 5000, '2026-11-18'), app('2', 3900, '2026-11-19')], from, today);
    expect(r).toEqual({ missing: [], unknown: [], waiting: 0 });
  });

  it('due arrotondamenti della banca inseriti nell\'app come uno solo sono abbinati alla loro somma', () => {
    const r = reconcile([bank('a', -100, '2026-11-17'), bank('b', -162, '2026-11-18')], [app('1', -262, '2026-11-18')], from, today);
    expect(r).toEqual({ missing: [], unknown: [], waiting: 0 });
  });

  it('somme che non tornano, o di segno opposto, restano in elenco', () => {
    const r = reconcile(
      [bank('a', -3250, '2026-11-18'), bank('b', 3705, '2026-11-18')],
      [app('1', -955, '2026-11-18'), app('2', 705, '2026-11-18'), app('3', -2300, '2026-11-18')],
      from,
      today,
    );
    expect(r.missing.map((b) => b.ref).sort()).toEqual(['a', 'b']);
    expect(r.unknown.map((t) => t.id).sort()).toEqual(['1', '2', '3']);
  });

  it('PayPal: la notifica può precedere l\'addebito di parecchi giorni', () => {
    const r = reconcile([bank('a', -999, '2026-11-20', '2026-11-20', 'PAYPAL *NEGOZIO')], [app('1', -999, '2026-11-12')], from, today);
    expect(r.missing).toEqual([]);
  });
});
