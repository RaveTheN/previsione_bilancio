import { Component, inject } from '@angular/core';
import { Auth } from '../../core/auth';

// shortcut: pagina segnaposto della Fase 0, sostituita dalla vista mese nella Fase 1.
@Component({
  selector: 'app-month',
  template: `
    <h1>Bilancio</h1>
    <p>Accesso eseguito come {{ auth.session()?.user?.email }}.</p>
    <p>Il registro dei movimenti arriva nella Fase 1.</p>
  `,
})
export class Month {
  protected readonly auth = inject(Auth);
}
