# Backup e ripristino

Il piano Free di Supabase non fa backup. Ogni notte un workflow nel repo **privato** `bilancio-backup` scarica il database, lo cifra con [age](https://github.com/FiloSottile/age) e lo salva con un commit. La storia di git conserva tutte le versioni.

## Configurazione (una volta sola)

1. **Chiave di cifratura.** Scarica age per Windows dalla [pagina dei rilasci](https://github.com/FiloSottile/age/releases) ed esegui:

   ```powershell
   .\age-keygen.exe -o bilancio-backup.key
   ```

   - Il comando stampa la **chiave pubblica** (`age1…`): serve al passo 3.
   - Il file `bilancio-backup.key` contiene la **chiave privata**: copiane il contenuto nel tuo password manager, stampane una copia da tenere offline, poi cancella il file. Senza questa chiave i backup sono illeggibili.
2. **Repo privato.** Crea su GitHub il repository privato `bilancio-backup` e copia [`backup/backup.yml`](backup/backup.yml) in `.github/workflows/backup.yml`.
3. **Impostazioni del repo privato** (Settings → Secrets and variables → Actions):

   - variabile `AGE_PUBLIC_KEY` = la chiave pubblica `age1…`;
   - secret `SUPABASE_DB_URL` = la stringa di connessione **Session pooler** del progetto di produzione (Supabase → Connect), con la password del database.
4. Avvia il workflow a mano (Actions → Backup notturno → Run workflow) e controlla che compaia il file `backup.tar.gz.age`.

## Ripristino

Serve Docker (per `psql`) e la chiave privata salvata in un file temporaneo `bilancio-backup.key`.

```powershell
age -d -i bilancio-backup.key backup.tar.gz.age | tar xzf -
docker run --rm -v "${PWD}:/b" -w /b postgres:17 psql --single-transaction --variable ON_ERROR_STOP=1 `
  --file roles.sql --file schema.sql --command 'SET session_replication_role = replica' --file data.sql `
  --dbname "<stringa di connessione del progetto di destinazione>"
docker run --rm -v "${PWD}:/b" -w /b postgres:17 psql --single-transaction --variable ON_ERROR_STOP=1 `
  --file history_schema.sql --file history_data.sql `
  --dbname "<stringa di connessione del progetto di destinazione>"
```

Il secondo comando serve solo se il backup contiene `history_schema.sql`: la storia delle migrazioni esiste dopo il primo `supabase db push`.

Dopo il ripristino cancella i file `.sql` estratti e la chiave temporanea.

La procedura segue la [guida ufficiale Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore). Se compaiono errori su `supabase_admin` o `cli_login_postgres`, la guida indica quali righe commentare.

## Prova di ripristino

Va fatta sul progetto **staging**, mai su quello di produzione:

1. ripristina l'ultimo backup su staging con i comandi sopra;
2. nella dashboard di staging, in Authentication → Users, deve comparire il tuo utente (lo stesso dell'accesso con codice OTP);
3. in Table Editor devono comparire i dati.
