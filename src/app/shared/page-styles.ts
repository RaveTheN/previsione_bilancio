/** Stili delle pagine con un elenco e un modulo sotto: debiti, desideri, spese condivise. */
export const PAGE_STYLES = `
  :host,
  fieldset {
    display: grid;
    /* Senza minmax una riga larga allargherebbe la colonna oltre lo schermo. */
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  h1 {
    margin: 0;
    font: var(--mat-sys-title-large);
  }
  h2 {
    margin: 0;
    font: var(--mat-sys-title-medium);
  }
  .card {
    display: grid;
    gap: 4px;
    padding: 12px;
    border-radius: 12px;
    background: var(--mat-sys-surface-container);
  }
  .label,
  .sub {
    font: var(--mat-sys-body-small);
    color: var(--mat-sys-on-surface-variant);
    overflow-wrap: anywhere;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    gap: 4px;
    padding: 10px 0;
    border-bottom: 1px solid var(--mat-sys-outline-variant);
  }
  .line {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .num {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  button {
    min-height: 44px;
  }
  form,
  label {
    display: grid;
    gap: 6px;
  }
  form {
    gap: 12px;
  }
  label {
    font: var(--mat-sys-label-large);
  }
  input,
  select {
    min-width: 0;
    min-height: 44px;
    padding: 0 8px;
    border: 1px solid var(--mat-sys-outline-variant);
    border-radius: 8px;
    background: var(--mat-sys-surface);
    color: var(--mat-sys-on-surface);
    font: var(--mat-sys-body-large);
  }
  p {
    margin: 0;
  }
  .note {
    color: var(--mat-sys-on-surface-variant);
  }
  .warn {
    color: var(--mat-sys-error);
  }
`;
