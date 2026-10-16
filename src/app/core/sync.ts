import { effect, inject, Injectable, signal } from '@angular/core';
import { Auth } from './auth';
import { OfflineError, PendingOp, Queue } from './queue';
import { supabase } from './supabase';

async function send(op: PendingOp): Promise<void> {
  const table = supabase.from(op.table);
  const { error, status } =
    op.kind === 'upsert' ? await table.upsert(op.row as never) : await table.delete().match(op.match);
  if (error) throw status === 0 ? new OfflineError(error.message) : new Error(error.message);
}

/** Coda delle scritture: prima in locale, poi verso Supabase appena c'è rete. */
@Injectable({ providedIn: 'root' })
export class Sync {
  private readonly auth = inject(Auth);
  private queue: Queue | null = null;
  private running: Promise<void> | null = null;

  /** Operazioni ancora da inviare. */
  readonly ops = signal<PendingOp[]>([]);
  /** Errore di sincronizzazione da mostrare (vuoto se tutto ok o se si è solo offline). */
  readonly error = signal('');
  /** Cresce dopo ogni invio riuscito: chi mostra dati li ricarica. */
  readonly synced = signal(0);

  constructor() {
    effect(() => {
      const userId = this.auth.session()?.user.id;
      // La coda resta legata all'utente: se la sessione scade, riparte dopo il login.
      this.queue = userId ? new Queue(`bilancio.coda.${userId}`, localStorage, send) : null;
      this.refresh();
      if (userId) void this.flush();
    });
    window.addEventListener('online', () => void this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.flush();
    });
  }

  /** Salva in locale e prova a inviare. Lancia se il salvataggio locale non riesce. */
  add(...ops: PendingOp[]): void {
    if (!this.queue) throw new Error('Sessione assente');
    this.queue.add(...ops);
    this.refresh();
    void this.flush();
  }

  flush(): Promise<void> {
    return (this.running ??= this.run().finally(() => (this.running = null)));
  }

  /** Scarta l'operazione che blocca la coda (dopo un errore che non si risolve riprovando). */
  discardFirst(): void {
    this.queue?.discardFirst();
    this.error.set('');
    this.refresh();
    void this.flush();
  }

  clear(): void {
    this.queue?.clear();
    this.refresh();
  }

  private async run(): Promise<void> {
    if (!this.queue || !this.queue.list().length) return;
    try {
      await this.queue.flush();
      this.error.set('');
    } catch (e) {
      if (!(e instanceof OfflineError)) this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.refresh();
      this.synced.update((n) => n + 1);
    }
  }

  private refresh(): void {
    this.ops.set(this.queue?.list() ?? []);
  }
}
