# Bilancio

PWA personale in italiano per spese, entrate e risparmi, usata da iPhone, iPad e PC. Angular 22 con Material, Supabase (Postgres, Auth, RLS), pubblicata su GitHub Pages: <https://ravethen.github.io/previsione_bilancio/>.

## Sviluppo locale

Richiede Node ≥ 22.22.3 e Docker Desktop.

```powershell
npm ci
npx supabase start      # stack Supabase locale (Docker)
npm start               # http://localhost:4200, punta allo stack locale
```

Le email con il codice di accesso dello stack locale si leggono su <http://127.0.0.1:54324>.

Primo avvio dello stack locale (e dopo ogni `npx supabase db reset`):

1. in Studio (<http://127.0.0.1:54323>) → Authentication → Add user: crea un utente con email confermata;
2. in Studio → SQL Editor: esegui `docs/setup-iniziale.sql`;
3. se vuoi dati realistici, esegui anche il file generato dall'importatore (vedi "Import dell'estratto conto");
4. nell'app, Altro → Bilancio: imposta mese di avvio, residuo all'avvio e secchio del risparmio.

Dopo una modifica allo schema rigenera i tipi con `npm run db:types`.

## Controlli

```powershell
npx ng test --watch=false   # test dell'app (Vitest)
npx supabase test db        # test del database (pgTAP)
npx ng build                # build di produzione
```

## Rilascio

- **App:** ogni push su `main` esegue test, build e deploy su GitHub Pages (`.github/workflows/deploy.yml`).
- **Database:** dal PC, prima del frontend:
  1. `npx supabase test db`;
  2. `npx supabase db push --dry-run`;
  3. `npx supabase db push`.

## Configurazione (una volta sola)

1. **Supabase:** crea due progetti nella regione UE, `bilancio` (produzione) e `bilancio-staging` (prove di ripristino). Nel progetto di produzione:
   - Authentication → Sign In / Providers → Email: lascia attivo il provider email;
   - Authentication → Emails → SMTP Settings: configura un SMTP personalizzato (per esempio Gmail con una password per app). Senza SMTP i template non si possono modificare;
   - Authentication → Emails → Magic Link: usa il testo di `supabase/templates/codice-accesso.html`, che contiene il codice `{{ .Token }}`;
   - Authentication → URL Configuration: Site URL `https://ravethen.github.io/previsione_bilancio/`;
   - Authentication → Users: crea il tuo utente con la tua email;
   - Authentication → Sign In / Providers: disattiva "Allow new users to sign up".
2. **App:** copia URL del progetto e publishable key (Project Settings → API Keys) in `src/environments/environment.ts`. Sono pubblici per natura: i dati li protegge la RLS.
3. **GitHub:** Settings → Pages → Source: "GitHub Actions"; Settings → Advanced Security: attiva Secret scanning e Push protection.
4. **Backup:** segui [docs/ripristino-backup.md](docs/ripristino-backup.md).
5. **Dati iniziali:** applica le migrazioni (`npx supabase db push`), poi nello SQL Editor di produzione esegui `docs/setup-iniziale.sql` (secchi, categorie, conti BBVA e Salvadanaio). Infine, nell'app, Altro → Bilancio: mese di avvio, residuo all'avvio, percentuale e secchio del risparmio.

## Import dell'estratto conto

```powershell
python tools/import/import.py bbva estratto.xlsx --saldo 1234.56 --al 2026-10-12
```

- Genera `tools/import/out/estratto-bbva.sql` (escluso da Git) e stampa un rapporto: righe, netto per mese, accantonamenti, movimenti da classificare e la ricostruzione del saldo di apertura.
- Il file SQL va eseguito nello SQL Editor di Supabase dopo `docs/setup-iniziale.sql`.
- Si può rieseguire: gli id sono stabili e le categorie assegnate a mano non vengono toccate.
- Le righe "TRASFERIMENTO PROGRAMMA IL TUO CONTO" diventano accantonamenti verso il Salvadanaio; tutto il resto entra senza categoria, nella riga "Da assegnare".

## Documentazione

- [Backup e ripristino](docs/ripristino-backup.md)
- [Spike iOS: verifica dei trigger dei Comandi Rapidi](docs/ios-spike.md)

I file Excel, `PLAN.md`, il mapping e gli output degli import contengono dati personali e sono esclusi da Git (`.gitignore`). Le fixture dei test usano solo dati finti.
