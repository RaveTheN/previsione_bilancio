import { searchDate, searchFilter } from './transactions';

describe('filtro della ricerca', () => {
  it('cerca nel nome della banca e nella nota, con il testo tra virgolette', () => {
    expect(searchFilter(' Lidl, s.p.a ', [], [])).toBe('merchant_raw.ilike."%Lidl, s.p.a%",note.ilike."%Lidl, s.p.a%"');
  });

  it('aggiunge esercenti e righe con quel nome', () => {
    expect(searchFilter('bar', ['m1', 'm2'], ['l1'])).toBe('merchant_raw.ilike."%bar%",note.ilike."%bar%",merchant_id.in.(m1,m2),line_id.in.(l1)');
  });

  it('un importo cerca sia l\'uscita sia l\'entrata', () => {
    expect(searchFilter('12,50', [], [])).toContain('amount_cents.in.(1250,-1250)');
  });

  it('le virgolette non chiudono il valore', () => {
    expect(searchFilter('a"b\\c', [], [])).toContain('"%abc%"');
  });
});

describe('ricerca: conti, tag e date', () => {
  it('aggiunge conti e movimenti trovati per tag', () => {
    expect(searchFilter('bar', [], [], ['a1'], ['t1', 't2'])).toContain('account_id.in.(a1),id.in.(t1,t2)');
  });

  it('legge una data, con o senza anno', () => {
    expect(searchDate('5/11', '2026')).toBe('2026-11-05');
    expect(searchDate('12/01/2027')).toBe('2027-01-12');
    expect(searchDate('12,50')).toBeNull();
    expect(searchFilter('5/11/2026', [], [])).toContain('booking_date.eq.2026-11-05');
  });
});
