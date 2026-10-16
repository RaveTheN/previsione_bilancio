import { applyPending, OfflineError, PendingOp, Queue } from './queue';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

const upsert = (id: string): PendingOp => ({ table: 'transactions', kind: 'upsert', row: { id } });

describe('Queue', () => {
  it('invia in ordine e svuota la coda', async () => {
    const sent: string[] = [];
    const queue = new Queue('k', memoryStorage(), async (op) => {
      if (op.kind === 'upsert') sent.push(String(op.row['id']));
    });
    queue.add(upsert('a'), upsert('b'));
    await queue.flush();
    expect(sent).toEqual(['a', 'b']);
    expect(queue.list()).toEqual([]);
  });

  it('offline: si ferma e conserva le operazioni non inviate', async () => {
    const queue = new Queue('k', memoryStorage(), async () => {
      throw new OfflineError('rete assente');
    });
    queue.add(upsert('a'), upsert('b'));
    await expect(queue.flush()).rejects.toBeInstanceOf(OfflineError);
    expect(queue.list()).toHaveLength(2);
  });

  it('dopo un invio riuscito rimuove solo l’operazione inviata', async () => {
    let calls = 0;
    const queue = new Queue('k', memoryStorage(), async () => {
      if (++calls === 2) throw new OfflineError('rete assente');
    });
    queue.add(upsert('a'), upsert('b'));
    await expect(queue.flush()).rejects.toThrow();
    expect(queue.list()).toEqual([upsert('b')]);
  });

  it('code di utenti diversi restano separate', () => {
    const storage = memoryStorage();
    new Queue('coda.utente-1', storage, async () => {}).add(upsert('a'));
    expect(new Queue('coda.utente-2', storage, async () => {}).list()).toEqual([]);
  });
});

describe('applyPending', () => {
  it('aggiunge, modifica ed elimina i movimenti in attesa', () => {
    const rows = [
      { id: '1', amount: 10 },
      { id: '2', amount: 20 },
    ];
    const ops: PendingOp[] = [
      { table: 'transactions', kind: 'upsert', row: { id: '2', amount: 25 } },
      { table: 'transactions', kind: 'upsert', row: { id: '3', amount: 30 } },
      { table: 'transactions', kind: 'delete', match: { id: '1' } },
    ];
    expect(applyPending(rows, ops)).toEqual([
      { id: '2', amount: 25 },
      { id: '3', amount: 30 },
    ]);
  });
});
