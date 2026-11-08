import { merchantChoice } from './quick-add';

describe('esercente scritto nel movimento', () => {
  const merchants = [{ id: 'm1', name: 'Il Bar' }];
  const manual = { merchant_id: null, merchant_raw: null };

  it('un movimento nuovo si collega subito a un esercente già in Rubrica, maiuscole a parte', () => {
    expect(merchantChoice(undefined, ' il bar ', '', merchants)).toEqual({ merchantId: 'm1', pendingName: null });
  });

  it('un nome nuovo si crea dopo l\'invio', () => {
    expect(merchantChoice(undefined, 'Lidl', '', merchants)).toEqual({ merchantId: null, pendingName: 'Lidl' });
  });

  it('un movimento fatto a mano e poi modificato funziona allo stesso modo', () => {
    expect(merchantChoice(manual, 'Il Bar', '', merchants).merchantId).toBe('m1');
  });

  it('campo vuoto o nome non cambiato: niente da fare', () => {
    expect(merchantChoice(undefined, '  ', '', merchants)).toEqual({ merchantId: null, pendingName: null });
    expect(merchantChoice({ merchant_id: 'm1', merchant_raw: null }, 'Il Bar', 'Il Bar', merchants)).toEqual({ merchantId: null, pendingName: null });
  });

  it('un movimento della banca passa dal collegamento del nome, che collega anche i suoi simili', () => {
    expect(merchantChoice({ merchant_id: null, merchant_raw: 'BAR SRL' }, 'Il Bar', '', merchants)).toEqual({ merchantId: null, pendingName: 'Il Bar' });
  });

  it('cambiare nome a un esercente già collegato lo rinomina', () => {
    expect(merchantChoice({ merchant_id: 'm1', merchant_raw: null }, 'Bar Nuovo', 'Il Bar', merchants)).toEqual({ merchantId: null, pendingName: 'Bar Nuovo' });
  });
});
