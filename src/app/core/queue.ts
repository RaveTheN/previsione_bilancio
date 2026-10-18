export type PendingOp =
  | { table: 'transactions' | 'tags' | 'transaction_tags'; kind: 'upsert'; row: Record<string, unknown> }
  | { table: 'transactions' | 'transaction_tags'; kind: 'delete'; match: Record<string, string> };

/** Errore di rete: l'operazione resta in coda e si riprova più tardi. */
export class OfflineError extends Error {}

/**
 * Coda delle scritture in attesa, salvata in localStorage per utente.
 * Le operazioni partono in ordine; al primo errore ci si ferma e il resto aspetta.
 */
export class Queue {
  constructor(
    private readonly key: string,
    private readonly storage: Storage,
    private readonly send: (op: PendingOp) => Promise<void>,
  ) {}

  list(): PendingOp[] {
    return JSON.parse(this.storage.getItem(this.key) ?? '[]') as PendingOp[];
  }

  /** Salva in locale: se il dispositivo non lo permette lancia, e l'app non mostra "Salvato". */
  add(...ops: PendingOp[]): void {
    this.save([...this.list(), ...ops]);
  }

  async flush(): Promise<void> {
    while (this.list().length) {
      await this.send(this.list()[0]);
      // Si rilegge la coda: durante l'invio potrebbero essere arrivate nuove operazioni.
      this.save(this.list().slice(1));
    }
  }

  discardFirst(): void {
    this.save(this.list().slice(1));
  }

  clear(): void {
    this.storage.removeItem(this.key);
  }

  private save(ops: PendingOp[]): void {
    if (ops.length) this.storage.setItem(this.key, JSON.stringify(ops));
    else this.storage.removeItem(this.key);
  }
}

/** Applica ai movimenti letti dal server quelli ancora in coda, così l'elenco li mostra subito. */
export function applyPending<T extends { id: string }>(rows: T[], ops: PendingOp[]): T[] {
  let out = rows;
  for (const op of ops) {
    if (op.table !== 'transactions') continue;
    if (op.kind === 'upsert') {
      const row = op.row as unknown as T;
      const old = out.find((r) => r.id === row.id);
      out = [...out.filter((r) => r.id !== row.id), { ...old, ...row }];
    } else {
      // Per id, oppure per gruppo: un trasferimento si elimina con entrambe le righe.
      const match = Object.entries(op.match);
      out = out.filter((r) => !match.every(([k, v]) => (r as Record<string, unknown>)[k] === v));
    }
  }
  return out;
}
