"""Import dei dati in Bilancio (solo libreria standard).

Uso (dalla cartella del progetto):
  python tools/import/import.py bbva 12-10-2026.xlsx --saldo 939.88 --al 2026-10-12

Scrive tools/import/out/estratto-bbva.sql e stampa un rapporto.
Il file SQL va eseguito nello SQL Editor di Supabase dopo docs/setup-iniziale.sql:
è idempotente (id stabili, on conflict do nothing) e non tocca le assegnazioni manuali.
I file di origine e gli output contengono dati personali: non vanno mai nel repo.
"""

import argparse
import collections
import datetime as dt
import re
import uuid
import zipfile
import xml.etree.ElementTree as ET
from decimal import Decimal
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
# Spazio dei nomi fisso: la stessa riga di origine produce sempre lo stesso id.
ID_NAMESPACE = uuid.UUID("6f1d3a52-6c1e-4f43-9a0e-0b7d4c2a9b11")
OUT = Path(__file__).parent / "out"
ACCANTONAMENTO = "TRASFERIMENTO PROGRAMMA IL TUO CONTO"


def read_sheet(path):
    """Righe del primo foglio come (numero_riga, {colonna: testo})."""
    z = zipfile.ZipFile(path)
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        strings = ["".join(t.text or "" for t in si.iter(NS + "t")) for si in root.findall(NS + "si")]
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for r in sheet.iter(NS + "row"):
        vals = {}
        for c in r.findall(NS + "c"):
            col = re.match(r"[A-Z]+", c.attrib["r"]).group(0)
            v = c.find(NS + "v")
            if c.attrib.get("t") == "inlineStr":
                vals[col] = "".join(t.text or "" for t in c.iter(NS + "t"))
            elif v is not None:
                vals[col] = strings[int(v.text)] if c.attrib.get("t") == "s" else v.text
        rows.append((int(r.attrib["r"]), vals))
    return rows


def parse_bbva_amount(text):
    """'-7.5 EUR' -> -750 centesimi. Solleva ValueError se il formato non è quello atteso."""
    m = re.fullmatch(r"(-?)(\d+)(?:\.(\d{1,2}))? EUR", text.strip())
    if not m:
        raise ValueError(f"importo non riconosciuto: {text!r}")
    cents = int(m.group(2)) * 100 + int((m.group(3) or "0").ljust(2, "0"))
    return -cents if m.group(1) else cents


def parse_date(text):
    return dt.datetime.strptime(text.strip(), "%d/%m/%Y").date()


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip() or None


def stable_id(*parts):
    return str(uuid.uuid5(ID_NAMESPACE, "|".join(str(p) for p in parts)))


def q(value):
    if value is None:
        return "null"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def self_check():
    assert parse_bbva_amount("-7.5 EUR") == -750
    assert parse_bbva_amount("970 EUR") == 97000
    assert parse_bbva_amount("-0.57 EUR") == -57
    assert parse_bbva_amount("-1234.05 EUR") == -123405
    try:
        parse_bbva_amount("1.234,56 EUR")
    except ValueError:
        pass
    else:
        raise AssertionError("formato italiano non doveva essere accettato")
    assert stable_id("a", 1) == stable_id("a", 1) != stable_id("a", 2)


def bbva(args):
    rows = read_sheet(args.file)
    header_row, header = next((n, v) for n, v in rows if v.get("B", "").strip() == "Data valuta")
    col = {name.strip(): c for c, name in header.items()}
    needed = ["Data valuta", "Data", "Causale", "Movimento", "Beneficiario", "Importo"]
    missing = [h for h in needed if h not in col]
    assert not missing, f"colonne mancanti nell'estratto: {missing}"

    data = [v for n, v in rows if n > header_row and v.get(col["Importo"])]
    seen = collections.Counter()
    out = []  # (id, conto, categoria, secchio, centesimi, data, data_valuta, esercente, nota, gruppo)
    per_month = collections.defaultdict(lambda: [0, 0])
    accantonamenti = da_classificare = 0
    total = 0
    for v in data:
        raw = tuple(v.get(col[h], "") for h in needed)
        seen[raw] += 1
        key = ("bbva",) + raw + (seen[raw],)  # due righe identiche restano distinte
        value_date, booking_date = parse_date(raw[0]), parse_date(raw[1])
        causale, movimento = clean(raw[2]), clean(raw[3])
        beneficiario = None if clean(raw[4]) in (None, "- -", "-") else clean(raw[4])
        cents = parse_bbva_amount(raw[5])
        total += cents
        m = per_month[booking_date.strftime("%Y-%m")]
        m[0] += 1
        m[1] += cents
        note = " · ".join(p for p in (movimento, beneficiario) if p)
        if causale == ACCANTONAMENTO:
            accantonamenti += 1
            group = stable_id(*key, "gruppo")
            out.append((stable_id(*key, "principale"), "BBVA", "Risparmio", "Future me", cents,
                        booking_date, value_date, causale, note, group))
            out.append((stable_id(*key, "salvadanaio"), "Salvadanaio", None, None, -cents,
                        booking_date, value_date, causale, note, group))
        else:
            da_classificare += 1
            out.append((stable_id(*key), "BBVA", None, None, cents,
                        booking_date, value_date, causale, note, None))

    # Controlli indipendenti prima di scrivere qualsiasi cosa.
    assert len(data) == sum(m[0] for m in per_month.values())
    assert len({r[0] for r in out}) == len(out), "id duplicati"
    assert sum(r[4] for r in out if r[1] == "BBVA") == total, "somma del conto principale diversa dall'estratto"

    OUT.mkdir(exist_ok=True)
    values = ",\n".join(
        "  (" + ", ".join(q(x) for x in (r[0], r[1], r[2], r[3], r[4], r[5].isoformat(), r[6].isoformat(), r[7], r[8], r[9])) + ")"
        for r in out
    )
    sql = f"""-- Generato da tools/import/import.py (estratto BBVA): idempotente. Contiene dati personali.
begin;

do $$
begin
  if (select count(*) from auth.users) <> 1 then
    raise exception 'Atteso esattamente un utente';
  end if;
  if (select count(*) from public.accounts where name in ('BBVA', 'Salvadanaio')) <> 2
     or not exists (select 1 from public.categories where name = 'Risparmio')
     or not exists (select 1 from public.buckets where name = 'Future me') then
    raise exception 'Esegui prima docs/setup-iniziale.sql';
  end if;
end $$;

insert into public.transactions
  (id, user_id, account_id, category_id, bucket_id, amount_cents, occurred_at,
   booking_date, value_date, merchant_raw, note, source, transfer_group_id)
select v.id::uuid, u.id, a.id, c.id, b.id, v.amount::bigint,
  (v.value_date::date + time '12:00') at time zone 'Europe/Rome',
  v.booking_date::date, v.value_date::date, v.merchant, v.note, 'import', v.grp::uuid
from (values
{values}
) as v (id, account, category, bucket, amount, booking_date, value_date, merchant, note, grp)
cross join auth.users u
join public.accounts a on a.user_id = u.id and a.name = v.account
left join public.categories c on c.user_id = u.id and c.name = v.category
left join public.buckets b on b.user_id = u.id and b.name = v.bucket
on conflict (id) do nothing;

commit;
"""
    target = OUT / "estratto-bbva.sql"
    target.write_text(sql, encoding="utf-8")

    print(f"Righe dell'estratto: {len(data)} (tutte importate)")
    print(f"  accantonamenti verso il Salvadanaio: {accantonamenti} (2 righe ciascuno)")
    print(f"  da classificare (riga 'Da assegnare'): {da_classificare}")
    print(f"Movimenti generati: {len(out)}")
    for month, (n, cents) in sorted(per_month.items()):
        print(f"  {month}: {n} righe, netto {cents / 100:+.2f} €")
    if args.saldo is not None:
        saldo = int(Decimal(args.saldo) * 100)
        al = dt.date.fromisoformat(args.al)
        later = [parse_bbva_amount(v[col["Importo"]]) for v in data if parse_date(v[col["Data"]]) > al]
        later_in = sum(c for c in later if c > 0)
        later_out = sum(c for c in later if c < 0)
        print(f"Saldo disponibile al {al}: {saldo / 100:.2f} €")
        print(f"Righe contabilizzate dopo il {al}: {len(later)} (entrate {later_in / 100:+.2f} €, uscite {later_out / 100:+.2f} €)")
        print("Apertura RICOSTRUITA al 1° settembre, secondo cosa include il saldo disponibile:")
        print(f"  A) tutte le righe:                         {(saldo - total) / 100:.2f} €")
        print(f"  B) le uscite successive ma non le entrate: {(saldo - (total - later_in)) / 100:.2f} €")
        print(f"  C) nessuna riga successiva:                {(saldo - (total - later_in - later_out)) / 100:.2f} €")
        print("  Da confermare con l'app della banca prima di usarla.")
    print(f"SQL scritto in {target}")


def main():
    self_check()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("bbva", help="estratto conto BBVA (.xlsx)")
    p.add_argument("file")
    p.add_argument("--saldo", help="saldo disponibile attuale, es. 939.88")
    p.add_argument("--al", help="data del saldo, es. 2026-10-12")
    args = parser.parse_args()
    {"bbva": bbva}[args.cmd](args)


if __name__ == "__main__":
    main()
