import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { MatSnackBar } from '@angular/material/snack-bar';
import { filter } from 'rxjs';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {
  constructor() {
    // Chiede a iOS di non cancellare i dati locali (coda offline) per inattività, dove supportato.
    void navigator.storage?.persist?.();
    const snackBar = inject(MatSnackBar);
    inject(SwUpdate)
      .versionUpdates.pipe(filter((event) => event.type === 'VERSION_READY'))
      .subscribe(() =>
        snackBar
          .open('Nuova versione disponibile', 'Aggiorna')
          .onAction()
          .subscribe(() => document.location.reload()),
      );
  }
}
