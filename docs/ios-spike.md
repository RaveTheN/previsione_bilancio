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

- I trigger scattano anche a telefono bloccato? Wallet: … · Notifica: …
- "Esegui immediatamente" è disponibile per il trigger Notifica? …
- Nomi esatti dei campi (Importo, Esercente, Carta o pass, Titolo, Sottotitolo, Messaggio): …
- Formato dell'importo di Wallet (es. "12,50 €" o "12.5"): …
- Esempi di notifiche della banca (5–10, anonimizzati):
  - …
- Con le anteprime delle notifiche nascoste a schermo bloccato, il testo arriva lo stesso? …

Alla fine disattiva o elimina le due automazioni di prova.
