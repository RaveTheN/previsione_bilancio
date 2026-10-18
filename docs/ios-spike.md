# Spike iOS: verifica dei trigger prima di costruirci sopra

Prova di 30–60 minuti sull'iPhone. Non serve ancora l'app: i comandi di prova salvano i dati in una nota.

## Prova 1 — Trigger "Transazione" (Wallet)

1. Comandi Rapidi → nuova automazione → **Transazione** → seleziona le carte Apple Pay → **Esegui immediatamente**.
2. Azioni:
   - *Testo* con dentro: `Importo: [Input comando › Importo] · Esercente: [Input comando › Esercente] · Carta: [Input comando › Carta o pass] · Data: [Data attuale]`;
   - *Aggiungi a nota* (o *Crea nota*) con quel testo, in una nota chiamata "Spike Bilancio".
3. Fai 2–3 pagamenti piccoli: almeno uno a **telefono bloccato**, uno in un locale con un nome "strano".

## Prova 2 — Trigger "Notifica" (iOS 27)

1. Nuova automazione → **Notifica** ("Quando ricevo una notifica") → app della banca (BBVA) → **Esegui immediatamente**, se disponibile. Nessun filtro.
2. Azioni: *Testo* con `Titolo: [Notifica › Titolo] · Sottotitolo: [Notifica › Sottotitolo] · Messaggio: [Notifica › Messaggio]` → *Aggiungi a nota* "Spike Bilancio".
3. Lascia attiva l'automazione per qualche pagamento con carta.

## Da annotare qui sotto (anonimizzato)

Prima di scrivere qui i testi, sostituisci gli esercenti con nomi finti, gli importi con valori inventati e le ultime cifre delle carte con `****`: il repo è pubblico.

Risultati della prova del 16–18/10/2026 (esercenti, importi, nomi e carta sostituiti con valori finti):

- **Wallet (Transazione).**
  - Scatta solo per i pagamenti Apple Pay; non scatta per gli acquisti online, per PayPal e, a quanto pare, per la carta fisica.
  - I campi *Carta o pass* e *Importo* sono oggetti, non testo: scritti in una nota diventano allegati `.txt`. Il loro contenuto è leggibile:
    - Carta: `CARTA DI DEBITO BBVA`;
    - Importo: `8,50 €`, con virgola decimale e simbolo dopo uno spazio.
  - Nel Comando Rapido vero vanno passati da un'azione *Testo* o da un *Dizionario*, che li converte in testo.
  - L'*Esercente* è il nome pulito di Mappe (es. `Bar Esempio music bar`), mentre la banca manda la ragione sociale troncata (`BAR ESEMPIO MUSIC B`): è il caso che la Rubrica deve unire.
- **Notifiche BBVA.** Titolo e sottotitolo sono vuoti. Due modelli diversi:
  - `Pagamento accettato 👍💳Pagamento di 12,00 EUR presso BOTTEGA ESEMPIO effettuato con la tua carta *****`
  - `Acquisto approvato` · `Puoi rateizzare questo acquisto da 48,30 EUR presso SUPERMERCATO 0000 con la tua carta *****. Simula le rate.`. Per questo pagamento il modello "Pagamento accettato" non è arrivato.
  - Gli esercenti con intermediario hanno un prefisso: `SumUp  *Negozio esempio` (con due spazi) e `PAYPAL *nomeutente`.
- **Notifiche PayPal** (in inglese, importo con `€` davanti e virgola o punto decimale):
  - `You sent €5.00 EUR to Mario Rossi`;
  - titolo `Your purchase at Servizio Esempio, LLC` · `Your €4,99 EUR payment was completed. Tap for more details.`;
  - titolo `Your purchase at CONSEGNE ESEMPIO SL` · `You authorized a payment of €19,40 EUR. Tap for more details.`. Per questo pagamento la BBVA non ha mandato nulla: finanziato da un'altra fonte?
- **Notifiche Vinted:** `Delivered! 🚚 - Vinted` · `Arrived Oct 16…`. Non contengono importi: vanno ignorate.
- **Copertura.** Le notifiche della banca coprono tutti i pagamenti con carta, compresi quelli online e quelli via PayPal. Wallet ne copre solo una parte, ma con il nome migliore. PayPal pagato con la carta BBVA genera due notifiche dello stesso importo: vanno unite.
- **Confermato il 18/10:** il trigger Notifica scatta a telefono bloccato, con "Esegui immediatamente" e con le anteprime nascoste. Sono arrivate le notifiche di tutte le transazioni.
- **Decisione:** si usano solo le notifiche. Wallet non serve: copre meno pagamenti e richiederebbe di unire due fonti. Se una notifica non arriva, la riserva è l'import dell'estratto conto.

Alla fine disattiva o elimina le due automazioni di prova.
