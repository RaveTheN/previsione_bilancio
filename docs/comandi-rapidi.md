# Comandi Rapidi: le notifiche della banca diventano movimenti

Servono tre pezzi sull'iPhone:

- il comando **"Bilancio · Invia"**, che mette in coda ogni notifica e la invia;
- l'automazione sulla **notifica BBVA**;
- l'automazione serale che **svuota la coda**.

Le etichette delle azioni possono essere leggermente diverse nella tua versione di iOS.

## Prima di iniziare

1. Nell'app: Altro → **Carte** → aggiungi le ultime 4 cifre della carta BBVA, collegate al conto BBVA.
2. Altro → **Dispositivi** → "Crea token" con nome "iPhone" → **Copia**. Il token si vede una volta sola: se lo perdi, revocalo e creane un altro.
3. Ti servono anche, da `src/environments/environment.ts`:
   - l'indirizzo del progetto (`supabaseUrl`);
   - la publishable key (`supabaseKey`).

   Sono dati pubblici: i dati li protegge la RLS, e il token può solo aggiungere notifiche.

## 1. Comando "Bilancio · Invia"

Comandi Rapidi → nuovo comando, chiamalo **Bilancio · Invia**. Nei dettagli del comando attiva "Ricevi input" di tipo *Dizionario*: se non arriva input, il comando si limita a svuotare la coda.

1. *Se* "Input comando" *ha qualsiasi valore*:
   1. *Imposta valore dizionario*: chiave `token`, valore il token copiato, dizionario "Input comando".
   2. *Ottieni valore dizionario* `event_id` dal risultato del passo 1.1.
   3. *Salva file*:
      - contenuto: il dizionario del passo 1.1;
      - percorso: `Bilancio/coda/` in iCloud Drive (cartella Comandi Rapidi), con nome il valore del passo 1.2;
      - "Chiedi dove salvare" disattivato; "Sovrascrivi se il file esiste" attivato.
2. *Ottieni contenuto della cartella* `Bilancio/coda`.
3. *Ripeti con ognuno*:
   1. *Ottieni contenuto dell'URL* con:
      - URL: `<supabaseUrl>/rest/v1/rpc/ingest`;
      - metodo: **POST**;
      - intestazioni: `apikey` = la publishable key, `Content-Type` = `application/json`;
      - corpo richiesta: **File**, con l'elemento della ripetizione.
   2. *Ottieni valore dizionario* `status` dal risultato.
   3. *Se* il risultato *ha qualsiasi valore*: *Elimina file* (l'elemento della ripetizione, senza conferma).
4. Facoltativo, nei primi giorni: *Mostra notifica* con il valore `message` della risposta.

**Se qualcosa va storto:**

- **Senza rete, o con Supabase in pausa,** il comando si ferma, i file restano in coda e partono al prossimo invio.
- **Con un token errato o revocato** la risposta non contiene `status`: i file restano in coda finché non correggi il token nel passo 1.1.
- **Il token sta nei file in coda** su iCloud Drive solo finché non vengono inviati.

## 2. Automazione sulla notifica BBVA

Automazione → nuova → **Notifica** → app **BBVA** → **Esegui immediatamente**, senza filtri sul testo.

1. *Se* "Messaggio" contiene `codice`, `OTP`, `password` o `accesso`: *Interrompi questo comando*. I codici di sicurezza non escono mai dal telefono; il server li scarta comunque.
2. *Data attuale*:
   - → *Formatta data* in **ISO 8601**, con ora → variabile `Quando`;
   - → *Formatta data* personalizzato `yyyyMMddHHmmssSSS`.
3. *Numero casuale* tra 1000 e 9999.
4. *Testo* `[data formattata]-[numero casuale]` → variabile `ID`.
5. *Dizionario* con:

   | Chiave | Valore |
   |---|---|
   | `event_id` | `ID` |
   | `occurred_at` | `Quando` |
   | `app` | il testo fisso `BBVA` |
   | `title` | Notifica › Titolo |
   | `subtitle` | Notifica › Sottotitolo |
   | `body` | Notifica › Messaggio |

6. *Esegui comando rapido* "Bilancio · Invia", con il dizionario come input.

## 3. Automazione "Svuota coda"

Automazione → **Ora del giorno** (ogni giorno alle 21:00) → **Esegui immediatamente** → *Esegui comando rapido* "Bilancio · Invia", senza input.

## Prova

1. Fai un pagamento piccolo con la carta: entro qualche secondo il movimento compare in Movimenti, con l'esercente della banca.
2. Se la notifica non viene riconosciuta, finisce in **Da rivedere** con il testo originale.
3. Le notifiche già registrate a mano, o arrivate due volte con modelli diversi, non creano doppioni.

## Risposte del server

| Risposta | Significato |
|---|---|
| `created` | movimento creato |
| `merged` | unito a un movimento già presente (inserito a mano o da un'altra notifica) |
| `duplicate` | evento già ricevuto (reinvio) |
| `ignored` | notifica da ignorare, o con un codice di sicurezza |
| `review` | non riconosciuta o con un errore: in Da rivedere |
| HTTP 401 | token errato o revocato |
| HTTP 429 | più di 120 notifiche nell'ultima ora |
| HTTP 400 | dati mancanti o testo oltre 2000 caratteri |
