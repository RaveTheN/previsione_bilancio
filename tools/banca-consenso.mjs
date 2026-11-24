// Consenso alla lettura del conto BBVA tramite Enable Banking: va rinnovato ogni 180 giorni.
//   1) node tools/banca-consenso.mjs                  → stampa il link per autorizzare il conto
//   2) node tools/banca-consenso.mjs "<indirizzo>"    → l'indirizzo su cui torni dopo l'autorizzazione
// Il passo 2 scrive in ~/.enablebanking, fuori dal progetto:
//   collega.sql   da eseguire nello SQL Editor di Supabase (la sessione, in bank_links)
//   segreti.env   per `npx supabase secrets set --env-file` (serve solo la prima volta)
// Tra i redirect consentiti dell'applicazione su Enable Banking deve esserci RITORNO.
import { createSign, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.enablebanking');
// Il ritorno non va sull'app, perché il suo router toglie i parametri dall'indirizzo. Qui non
// risponde nessuno (Enable Banking accetta solo https): il browser mostra un errore e l'indirizzo
// completo resta nella barra.
const RITORNO = 'https://localhost:8765/';
const pem = readdirSync(DIR).filter((f) => f.endsWith('.pem'));
if (pem.length !== 1) throw new Error(`In ${DIR} serve un solo file .pem, trovati ${pem.length}`);
const APP = pem[0].slice(0, -4); // il file ha come nome l'ID dell'applicazione
const KEY = readFileSync(join(DIR, pem[0]), 'utf8');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ typ: 'JWT', alg: 'RS256', kid: APP })}.${b64({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(KEY, 'base64url')}`;
}

async function api(path, body) {
  const res = await fetch(`https://api.enablebanking.com${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text}`);
  return JSON.parse(text);
}

const arg = process.argv[2];
if (arg) {
  const q = new URL(arg).searchParams;
  if (!q.has('code')) throw new Error(`Errore dalla banca: ${q.get('error')} | ${q.get('error_description')}`);
  const session = await api('/sessions', { code: q.get('code') });
  if (!/^[\w-]+$/.test(session.session_id)) throw new Error('Sessione in un formato inatteso');
  // La sottoquery su auth.users dà errore se gli utenti non sono esattamente uno.
  writeFileSync(join(DIR, 'collega.sql'), `insert into public.bank_links (user_id, session_id)
values ((select id from auth.users), '${session.session_id}')
on conflict (user_id) do update set session_id = excluded.session_id, updated_at = now();
`);
  // La chiave su una riga sola: i file .env non reggono bene i valori su più righe.
  writeFileSync(join(DIR, 'segreti.env'), `EB_APP_ID=${APP}\nEB_PRIVATE_KEY=${KEY.replace(/-----[^-]+-----|\s/g, '')}\n`);
  console.log(`Consenso valido fino al ${session.access?.valid_until}.`);
  console.log(`Esegui nello SQL Editor di Supabase il contenuto di ${join(DIR, 'collega.sql')}`);
} else {
  const { aspsps } = await api('/aspsps?country=IT');
  const bank = aspsps.find((a) => /bbva/i.test(a.name));
  if (!bank) throw new Error('BBVA non è tra le banche italiane disponibili');
  const auth = await api('/auth', {
    access: { valid_until: new Date(Date.now() + (bank.maximum_consent_validity - 3600) * 1000).toISOString() },
    aspsp: { name: bank.name, country: bank.country },
    state: randomUUID(),
    redirect_url: RITORNO,
    psu_type: 'personal',
  });
  console.log(`Apri questo link e autorizza. Alla fine il browser dice che la pagina non è raggiungibile: è previsto.\nCopia l'indirizzo dalla barra e rilancia lo script con l'indirizzo tra virgolette.\n\n${auth.url}`);
}
