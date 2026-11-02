/**
 * Testo libero in una cella CSV. Excel esegue come formula le celle che iniziano con = + - @:
 * i nomi degli esercenti arrivano dalle notifiche, quindi sono input non fidato.
 */
export function csvText(value: string | null | undefined): string {
  const text = value ?? '';
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** CSV per Excel in italiano: separatore ";", UTF-8 con BOM, fine riga CRLF. */
export function toCsv(rows: string[][]): string {
  const cell = (value: string) => (/[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return '\uFEFF' + rows.map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

/** "2026-10-16" → "16/10/2026", il formato che Excel italiano riconosce come data. */
export function italianDate(iso: string): string {
  return iso.split('-').reverse().join('/');
}

function icsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Righe iCalendar al massimo di 75 byte: 60 caratteri lasciano margine agli accenti. */
function icsFold(line: string): string {
  return line.match(/.{1,60}/gu)?.join('\r\n ') ?? line;
}

/** Evento di un giorno con un avviso 3 giorni prima, per il Calendario. */
export function reminderIcs(uid: string, summary: string, date: string, now = new Date()): string {
  const day = date.replace(/-/g, '');
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bilancio//IT',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}@bilancio`,
    `DTSTAMP:${now.toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`,
    `SUMMARY:${icsText(summary)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(summary)}`,
    'TRIGGER:-P3D',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(icsFold)
    .join('\r\n') + '\r\n';
}

/**
 * Consegna un file all'utente. Sugli schermi touch usa il foglio di condivisione, l'unica via
 * affidabile da un'app sulla Home di iOS; altrimenti, o se non è permesso, lo scarica.
 */
export async function saveFile(name: string, type: string, content: string): Promise<void> {
  const file = new File([content], name, { type });
  if (navigator.maxTouchPoints > 0 && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
