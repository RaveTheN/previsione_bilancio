import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Auth } from '../../core/auth';

// Tab bar in basso su schermo stretto, barra laterale da 840 px in su.
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <nav aria-label="Navigazione principale">
      <a routerLink="/mese" routerLinkActive="active">
        <svg viewBox="0 -960 960 960" aria-hidden="true">
          <path
            d="M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Z"
          />
        </svg>
        <span>Mese</span>
      </a>
      <button type="button" (click)="signOut()">
        <svg viewBox="0 -960 960 960" aria-hidden="true">
          <path
            d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z"
          />
        </svg>
        <span>Esci</span>
      </button>
    </nav>
    <main><router-outlet /></main>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-rows: 1fr auto;
      min-height: 100dvh;
    }
    main {
      padding: calc(16px + env(safe-area-inset-top)) 16px 16px;
    }
    nav {
      order: 2;
      position: sticky;
      bottom: 0;
      display: flex;
      justify-content: space-around;
      padding-bottom: env(safe-area-inset-bottom);
      background: var(--mat-sys-surface-container);
    }
    a,
    button {
      display: grid;
      justify-items: center;
      gap: 2px;
      min-width: 64px;
      min-height: 56px;
      padding: 6px 12px;
      border: 0;
      background: none;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      text-decoration: none;
      cursor: pointer;
    }
    .active {
      color: var(--mat-sys-primary);
    }
    svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }
    @media (min-width: 840px) {
      :host {
        grid-template-columns: auto 1fr;
        grid-template-rows: none;
      }
      nav {
        order: 0;
        top: 0;
        height: 100dvh;
        flex-direction: column;
        justify-content: flex-start;
        gap: 8px;
        padding: 16px 0;
      }
    }
  `,
})
export class Shell {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);

  async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/accesso');
  }
}
