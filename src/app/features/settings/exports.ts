import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { csvText, italianDate, saveFile, toCsv } from '../../core/files';
import { currentMonth, Ledger, todayIso } from '../../core/ledger';
import { centsToInput, formatCents } from '../../core/money';
import { BudgetLine, MonthOverview, supabase, Transaction } from '../../core/supabase';
import { pivotYear } from '../year/pivot';

const PAGE = 1000;

/** Legge tutto a pagine: Supabase restituisce al massimo 1000 righe per richiesta. */
async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return all;
  }
}

/** Entrate dell'anno per riga (es. Vinted) ed export in CSV. */
@Component({
  selector: 'app-exports',
  imports: [MatButtonModule],
  template: `
    <section>
      <h2>Entrate {{ year }} per riga</h2>
      <ul>
        @for (r of income(); track r.key) {
          <li>
            <span>{{ r.label }}</span><span class="num">{{ fmt(r.total.actual ?? 0) }}</span>
          </li>
        } @empty {
          <p class="note">Nessuna entrata assegnata.</p>
        }
      </ul>
    </section>

    <section>
      <h2>Esporta</h2>
      <p class="note">File CSV per Excel e Numbers. La copia in più, oltre al database e ai backup.</p>
      <div class="actions">
        <button mat-stroked-button type="button" [disabled]="busy()" (click)="exportMovements()">Movimenti</button>
        <button mat-stroked-button type="button" [disabled]="busy()" (click)="exportForecast()">Previsioni</button>
      </div>
    </section>
  `,
  styles: `
    :host,
    section {
      display: grid;
      gap: 8px;
    }
    :host {
      gap: 24px;
    }
    h2 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      min-height: 40px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .num {
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .actions button {
      min-height: 44px;
    }
    .note {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class Exports implements OnInit {
  private readonly ledger = inject(Ledger);
  private readonly snackBar = inject(MatSnackBar);
  protected readonly fmt = formatCents;
  protected readonly year = Number(currentMonth().slice(0, 4));
  protected readonly busy = signal(false);
  private readonly months = signal<MonthOverview[]>([]);

  protected readonly income = computed(() => {
    const months = this.months();
    if (!months.length) return [];
    const pivot = pivotYear(months, this.ledger.buckets());
    return (pivot.groups.find((g) => g.key === 'entrate')?.rows ?? []).filter((r) => r.total.actual);
  });

  ngOnInit(): void {
    void supabase.rpc('year_grid', { p_year: this.year }, { get: true }).then((res) => {
      if (res.data) this.months.set(res.data as unknown as MonthOverview[]);
    });
  }

  protected exportMovements(): Promise<void> {
    return this.run('movimenti', async () => {
      // La riga viene con il movimento: quella di un altro mese non è tra le righe caricate.
      const rows = await readAll<Transaction & { budget_lines: { name: string; bucket_id: string | null } | null }>((from, to) =>
        supabase.from('transactions').select('*, transaction_tags(tag_id), budget_lines(name, bucket_id)').order('booking_date').order('id').range(from, to),
      );
      const { accountById, bucketById, merchantById, tagById } = this.ledger;
      return [
        ['Data', 'Data valuta', 'Conto', 'Importo', 'Riga', 'Secchio', 'Esercente', 'Nome originale', 'Nota', 'Tag', 'Trasferimento', 'Fonte', 'Stato'],
        ...rows.map((t) => [
          italianDate(t.booking_date),
          t.value_date ? italianDate(t.value_date) : '',
          csvText(accountById().get(t.account_id)?.name),
          centsToInput(t.amount_cents),
          csvText(t.budget_lines?.name),
          csvText(t.budget_lines ? (bucketById().get(t.budget_lines.bucket_id ?? '')?.name ?? 'Entrate') : ''),
          csvText(merchantById().get(t.merchant_id ?? '')?.name),
          csvText(t.merchant_raw),
          csvText(t.note),
          csvText((t.transaction_tags ?? []).map((x) => tagById().get(x.tag_id)?.name).join(', ')),
          t.transfer_group_id ? 'sì' : '',
          t.source,
          t.status,
        ]),
      ];
    });
  }

  protected exportForecast(): Promise<void> {
    return this.run('previsioni', async () => {
      const rows = await readAll<BudgetLine>((from, to) => supabase.from('budget_lines').select().order('month').order('id').range(from, to));
      const { bucketById } = this.ledger;
      return [
        ['Mese', 'Riga', 'Secchio', 'Importo'],
        ...rows.map((b) => [
          italianDate(b.month).slice(3),
          csvText(b.name),
          csvText(bucketById().get(b.bucket_id ?? '')?.name ?? 'Entrate'),
          centsToInput(b.amount_cents),
        ]),
      ];
    });
  }

  private async run(name: string, rows: () => Promise<string[][]>): Promise<void> {
    this.busy.set(true);
    try {
      await saveFile(`bilancio-${name}-${todayIso()}.csv`, 'text/csv', toCsv(await rows()));
    } catch (e) {
      this.snackBar.open(`Export non riuscito: ${e instanceof Error ? e.message : String(e)}`, 'OK');
    } finally {
      this.busy.set(false);
    }
  }
}
