const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });

/** 1250 → "12,50 €" */
export function formatCents(cents: number): string {
  return eur.format(cents / 100);
}

/**
 * Importo digitato → centesimi positivi, oppure null se non valido.
 * Con un solo separatore, è decimale se seguito da 1–2 cifre ("12,5", "12.50")
 * e separatore delle migliaia se seguito da 3 ("1.234"); con entrambi, decide l'ultimo.
 */
export function parseAmount(text: string): number | null {
  const t = text.replace(/[\s€]/g, '');
  if (!/^\d+([.,]\d+)*$/.test(t)) return null;
  const last = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
  const decimals = last < 0 ? 0 : t.length - last - 1;
  const isDecimal = last >= 0 && ((t.includes(',') && t.includes('.')) || decimals <= 2);
  const intDigits = (isDecimal ? t.slice(0, last) : t).replace(/[.,]/g, '');
  const decDigits = isDecimal ? t.slice(last + 1).padEnd(2, '0') : '00';
  if (decDigits.length > 2) return null;
  const cents = Number(intDigits) * 100 + Number(decDigits);
  return cents > 0 ? cents : null;
}

/** Come parseAmount, ma accetta anche zero e il segno meno: per saldi e previsioni. */
export function parseSignedAmount(text: string): number | null {
  const t = text.replace(/[\s€]/g, '');
  const negative = t.startsWith('-');
  const digits = negative ? t.slice(1) : t;
  const cents = /^0+([.,]0+)?$/.test(digits) ? 0 : parseAmount(digits);
  return cents === null ? null : negative && cents ? -cents : cents;
}

/** Centesimi → testo per un campo modificabile: -1250 → "-12,50". */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * Esito della differenza effettivo − previsione, con importi con segno: per entrate e
 * uscite una differenza positiva è meglio del previsto; per il risparmio è meglio
 * accantonare di più (cioè una differenza negativa).
 */
export function diffTone(kind: string, forecast: number, actual: number): 'better' | 'worse' | 'even' {
  const diff = (actual - forecast) * (kind === 'saving' ? -1 : 1);
  return diff > 0 ? 'better' : diff < 0 ? 'worse' : 'even';
}
