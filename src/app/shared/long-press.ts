import { Directive, ElementRef, inject, output } from '@angular/core';

/**
 * Pressione lunga, o tasto destro del mouse. Un gesto non è mai l'unica via: chi lo usa offre
 * anche un pulsante o un tasto.
 */
@Directive({
  selector: '[appLongPress]',
  host: {
    // Su iPhone la pressione lunga aprirebbe la selezione del testo.
    style: '-webkit-touch-callout: none; -webkit-user-select: none; user-select: none',
    '(pointerdown)': 'start($event)',
    '(pointerup)': 'stop()',
    '(pointerleave)': 'stop()',
    // Arriva quando il dito inizia a scorrere la pagina.
    '(pointercancel)': 'stop()',
    '(contextmenu)': 'menu($event)',
  },
})
export class LongPress {
  /** L'evento che ha iniziato il gesto: serve a sapere dove, es. su quale fetta di un grafico. */
  readonly appLongPress = output<Event>();
  private timer?: ReturnType<typeof setTimeout>;
  private fired = 0;
  /** Il tocco che chiude una pressione lunga non è un tocco: non deve arrivare a chi sta dentro. */
  private swallow = false;

  constructor() {
    const swallowClick = (e: Event) => {
      if (this.swallow) e.stopPropagation();
      this.swallow = false;
    };
    // In cattura: prima dei pulsanti (e del grafico) contenuti nell'elemento.
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.addEventListener('click', swallowClick, true);
  }

  protected start(e: PointerEvent): void {
    this.stop();
    this.swallow = false;
    if (e.button !== 0) return;
    this.timer = setTimeout(() => {
      this.swallow = true;
      this.fire(e);
    }, 500);
  }

  protected stop(): void {
    clearTimeout(this.timer);
  }

  /** Su Android la pressione lunga apre anche il menu contestuale: non deve valere due volte. */
  protected menu(e: Event): void {
    e.preventDefault();
    this.stop();
    if (Date.now() - this.fired > 1000) this.fire(e);
  }

  private fire(e: Event): void {
    this.fired = Date.now();
    this.appLongPress.emit(e);
  }
}
