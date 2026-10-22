import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Ledger } from '../../core/ledger';
import { Sync } from '../../core/sync';
import { QuickAddLauncher } from '../quick-add/quick-add';

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
      <!-- La griglia serve su PC e iPad: su schermo stretto c'è la vista mese. -->
      <a class="wide" routerLink="/anno" routerLinkActive="active">
        <svg viewBox="0 -960 960 960" aria-hidden="true">
          <path
            d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h133v-133H200v133Zm213 0h134v-133H413v133Zm214 0h133v-133H627v133ZM200-413h133v-134H200v134Zm213 0h134v-134H413v134Zm214 0h133v-134H627v134ZM200-627h133v-133H200v133Zm213 0h134v-133H413v133Zm214 0h133v-133H627v133Z"
          />
        </svg>
        <span>Anno</span>
      </a>
      <a routerLink="/movimenti" routerLinkActive="active">
        <svg viewBox="0 -960 960 960" aria-hidden="true">
          <path
            d="M280-600v-80h560v80H280Zm0 160v-80h560v80H280Zm0 160v-80h560v80H280ZM160-600q-17 0-28.5-11.5T120-640q0-17 11.5-28.5T160-680q17 0 28.5 11.5T200-640q0 17-11.5 28.5T160-600Zm0 160q-17 0-28.5-11.5T120-480q0-17 11.5-28.5T160-520q17 0 28.5 11.5T200-480q0 17-11.5 28.5T160-440Zm0 160q-17 0-28.5-11.5T120-320q0-17 11.5-28.5T160-360q17 0 28.5 11.5T200-320q0 17-11.5 28.5T160-280Z"
          />
        </svg>
        <span>Movimenti</span>
      </a>
      <button type="button" class="add" aria-label="Nuovo movimento" (click)="quickAdd.open()">
        <svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z" /></svg>
      </button>
      <a routerLink="/da-rivedere" routerLinkActive="active">
        <svg viewBox="0 -960 960 960" aria-hidden="true">
          <path
            d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-120H640q-30 38-71.5 59T480-240q-47 0-88.5-21T320-320H200v120Zm280-120q38 0 69-22t43-58h168v-360H200v360h168q12 36 43 58t69 22Z"
          />
        </svg>
        <span>Da rivedere</span>
        @if (ledger.reviewCount()) {
          <span class="badge" [attr.aria-label]="ledger.reviewCount() + ' da rivedere'">{{ ledger.reviewCount() }}</span>
        }
      </a>
      <a routerLink="/altro" routerLinkActive="active">
        <svg viewBox="0 -960 960 960" aria-hidden="true">
          <path
            d="M240-400q-33 0-56.5-23.5T160-480q0-33 23.5-56.5T240-560q33 0 56.5 23.5T320-480q0 33-23.5 56.5T240-400Zm240 0q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm240 0q-33 0-56.5-23.5T640-480q0-33 23.5-56.5T720-560q33 0 56.5 23.5T800-480q0 33-23.5 56.5T720-400Z"
          />
        </svg>
        <span>Altro</span>
        @if (sync.ops().length) {
          <span class="badge" [attr.aria-label]="sync.ops().length + ' in attesa'">{{ sync.ops().length }}</span>
        }
      </a>
    </nav>
    <main>
      @if (sync.error()) {
        <a class="banner" role="alert" routerLink="/altro">Sincronizzazione bloccata: tocca per i dettagli</a>
      }
      <router-outlet />
    </main>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-rows: 1fr auto;
      min-height: 100dvh;
    }
    main {
      display: grid;
      align-content: start;
      gap: 12px;
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      box-sizing: border-box;
      padding: calc(12px + env(safe-area-inset-top)) 16px 24px;
    }
    nav {
      order: 2;
      position: sticky;
      bottom: 0;
      z-index: 10;
      display: flex;
      justify-content: space-around;
      align-items: center;
      padding-bottom: env(safe-area-inset-bottom);
      background: var(--mat-sys-surface-container);
    }
    a,
    button {
      position: relative;
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
    .add {
      place-items: center;
      width: 56px;
      min-width: 56px;
      height: 56px;
      padding: 0;
      border-radius: 16px;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }
    .badge {
      position: absolute;
      top: 2px;
      right: 10px;
      min-width: 18px;
      padding: 0 4px;
      border-radius: 9px;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font: var(--mat-sys-label-small);
    }
    .banner {
      display: block;
      padding: 12px;
      border-radius: 12px;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    /* La griglia usa tutta la larghezza. */
    main:has(app-year) {
      max-width: none;
    }
    .wide {
      display: none;
    }
    @media (min-width: 840px) {
      .wide {
        display: grid;
      }
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
  protected readonly quickAdd = inject(QuickAddLauncher);
  protected readonly sync = inject(Sync);
  protected readonly ledger = inject(Ledger);
}
