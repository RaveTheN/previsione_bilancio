import { DestroyRef, inject, Signal, signal } from '@angular/core';

/** Stato della connessione, aggiornato dagli eventi del browser. Va creato in un contesto di injection. */
export function onlineSignal(): Signal<boolean> {
  const online = signal(navigator.onLine);
  const update = () => online.set(navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  inject(DestroyRef).onDestroy(() => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  });
  return online.asReadonly();
}
