// Controllo con la banca (Enable Banking): saldo disponibile e movimenti contabilizzati degli
// ultimi giorni. Sola lettura: non scrive nulla nel database, il confronto lo fa l'app.
// Segreti: EB_APP_ID ed EB_PRIVATE_KEY (PKCS#8, anche su una riga sola). La sessione sta in bank_links.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const DAYS = 14;

class Fail extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (text: string) => new TextEncoder().encode(text);

async function jwt(): Promise<string> {
  const der = Uint8Array.from(atob(Deno.env.get('EB_PRIVATE_KEY')!.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const body = [
    { typ: 'JWT', alg: 'RS256', kid: Deno.env.get('EB_APP_ID') },
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 300 },
  ].map((part) => b64url(utf8(JSON.stringify(part)))).join('.');
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(body))))}`;
}

// deno-lint-ignore no-explicit-any
async function bank(token: string, path: string, psu: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`https://api.enablebanking.com${path}`, { headers: { Authorization: `Bearer ${token}`, ...psu } });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  if (body.error === 'ASPSP_RATE_LIMIT_EXCEEDED') throw new Fail(429, 'La banca ha raggiunto il limite di richieste di oggi: riprova più tardi');
  if (/SESSION/.test(body.error ?? '')) throw new Fail(409, 'Consenso scaduto o revocato: rinnovalo con tools/banca-consenso.mjs');
  throw new Fail(502, `La banca non ha risposto: ${body.message ?? res.status}`);
}

const cents = (amount: string) => Math.round(Number(amount) * 100);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    // La RLS dà la riga solo al suo proprietario: è questo il controllo di accesso della funzione.
    const link = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/bank_links?select=session_id`, {
      headers: {
        Authorization: req.headers.get('Authorization') ?? '',
        apikey: req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      },
    });
    const [row] = link.ok ? await link.json() : [];
    if (!row) throw new Fail(link.ok ? 404 : 401, link.ok ? 'Nessun conto collegato' : 'Accesso non valido');

    const token = await jwt();
    const session = await bank(token, `/sessions/${row.session_id}`);
    if (session.status !== 'AUTHORIZED') throw new Fail(409, 'Consenso scaduto o revocato: rinnovalo con tools/banca-consenso.mjs');
    // shortcut: un solo conto per sessione (il conto corrente); con più conti serve sceglierlo in bank_links.
    const account = session.accounts[0];

    // Con l'indirizzo di chi sta usando l'app la banca la conta come una lettura richiesta dall'utente,
    // non come una delle poche letture automatiche concesse ogni giorno.
    const psu: Record<string, string> = {};
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim();
    if (ip) psu['Psu-Ip-Address'] = ip;
    if (req.headers.get('user-agent')) psu['Psu-User-Agent'] = req.headers.get('user-agent')!;

    const from = new Date(Date.now() - DAYS * 86400e3).toISOString().slice(0, 10);
    const [{ balances }, transactions] = await Promise.all([
      bank(token, `/accounts/${account}/balances`, psu),
      (async () => {
        const all = [];
        let key: string | undefined;
        do {
          const page = await bank(token, `/accounts/${account}/transactions?date_from=${from}${key ? `&continuation_key=${encodeURIComponent(key)}` : ''}`, psu);
          all.push(...page.transactions);
          key = page.continuation_key;
        } while (key);
        return all;
      })(),
    ]);

    // ITAV è il disponibile, quello che mostra l'app della banca; CLBD (contabile) non serve.
    const available = balances.find((b: { balance_type: string }) => b.balance_type === 'ITAV');
    return Response.json(
      {
        available_cents: available ? cents(available.balance_amount.amount) : null,
        valid_until: session.access.valid_until,
        from,
        // deno-lint-ignore no-explicit-any
        transactions: transactions.map((t: any) => {
          // "TIPO // SOTTOTIPO // DETTAGLIO": il dettaglio è l'esercente o la causale.
          const [kind, , detail] = (t.remittance_information?.[0] ?? '').split('//').map((s: string) => s.replace(/\s+/g, ' ').trim());
          return {
            ref: t.entry_reference,
            amount_cents: (t.credit_debit_indicator === 'CRDT' ? 1 : -1) * cents(t.transaction_amount.amount),
            booking_date: t.booking_date,
            value_date: t.value_date ?? t.booking_date,
            kind,
            // Come nell'import dell'estratto: di un numero di carta restano le ultime 4 cifre.
            text: (detail || kind).replace(/\b\d{9,15}(\d{4})\b/g, '****$1'),
          };
        }),
      },
      { headers: CORS },
    );
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500;
    return Response.json({ message: e instanceof Error ? e.message : String(e) }, { status, headers: CORS });
  }
});
