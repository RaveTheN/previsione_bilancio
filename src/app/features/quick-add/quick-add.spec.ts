import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { vi } from 'vitest';
import { Ledger } from '../../core/ledger';
import { supabase } from '../../core/supabase';
import { Sync } from '../../core/sync';
import { merchantChoice, QuickAdd } from './quick-add';

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

describe('riga creata dalla finestra del movimento', () => {
  const created = { id: 'l1', name: 'Regalo', bucket_id: 'b1', sort_order: 1 };
  let query: Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
  let updateResult: { data: null; error: { code: string; message: string } | null; status: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sheet: any;

  beforeEach(() => {
    updateResult = { data: null, error: null, status: 200 };
    let result: unknown = { data: [], error: null, status: 200 };
    const q = {} as typeof query;
    for (const method of ['select', 'eq', 'order']) q[method] = vi.fn(() => q);
    q['insert'] = vi.fn(() => ((result = { data: created, error: null, status: 201 }), q));
    q['single'] = vi.fn(() => q);
    q['update'] = vi.fn(() => ((result = updateResult), q));
    q['delete'] = vi.fn(() => ((result = { data: null, error: null, status: 204 }), q));
    q.then = (resolve: (v: unknown) => unknown) => {
      const value = result;
      result = { data: [], error: null, status: 200 };
      return Promise.resolve(value).then(resolve);
    };
    query = q;
    vi.spyOn(supabase, 'from').mockReturnValue(q as never);
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: 0, error: null } as never);

    TestBed.configureTestingModule({
      providers: [
        { provide: MAT_BOTTOM_SHEET_DATA, useValue: {} },
        { provide: MatBottomSheetRef, useValue: { dismiss: vi.fn() } },
        { provide: Sync, useValue: {} },
        {
          provide: Ledger,
          useValue: {
            month: signal('2026-11-01'),
            lines: signal([]),
            buckets: signal([]),
            accounts: signal([]),
            tags: signal([]),
            merchants: signal([]),
            merchantById: signal(new Map()),
            tagById: signal(new Map()),
            transactions: signal([]),
            load: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });
    sheet = TestBed.runInInjectionContext(() => new QuickAdd());
    sheet.date.set('2026-11-08');
    sheet.newLineName = 'Regalo';
    sheet.newLineBucket = 'b1';
  });

  afterEach(() => vi.restoreAllMocks());

  const createThenGoToOctober = async () => {
    await sheet.createLine();
    sheet.setDate('2026-10-15');
    await sheet.moves;
  };

  it('nasce nel mese della data', async () => {
    sheet.date.set('2026-10-15');
    await sheet.createLine();
    expect(query['insert']).toHaveBeenCalledWith(expect.objectContaining({ month: '2026-10-01', name: 'Regalo' }));
  });

  it('se poi la data cambia mese, la riga la segue', async () => {
    await createThenGoToOctober();
    expect(query['update']).toHaveBeenCalledWith({ month: '2026-10-01' });
    expect(query['delete']).not.toHaveBeenCalled();
  });

  it('se quel mese ha già una riga con lo stesso nome, la doppia si elimina', async () => {
    updateResult = { data: null, error: { code: '23505', message: 'duplicate' }, status: 409 };
    await createThenGoToOctober();
    expect(query['delete']).toHaveBeenCalled();
  });

  it('una riga scelta dopo averne creata un\'altra non sposta quella creata', async () => {
    await sheet.createLine();
    sheet.pickLine({ id: 'l2', name: 'Altra', bucket_id: 'b1', sort_order: 2 });
    sheet.setDate('2026-10-15');
    await sheet.moves;
    expect(query['update']).not.toHaveBeenCalled();
  });
});
