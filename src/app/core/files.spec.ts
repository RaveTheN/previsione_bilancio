import { csvText, italianDate, reminderIcs, toCsv } from './files';

describe('CSV', () => {
  it('BOM, separatore ";", CRLF, virgolette solo dove servono', () => {
    expect(toCsv([['Data', 'Nota'], ['16/10/2026', 'a;b'], ['x', 'di "lui"'], ['y', 'due\nrighe']])).toBe(
      '﻿Data;Nota\r\n16/10/2026;"a;b"\r\nx;"di ""lui"""\r\ny;"due\nrighe"\r\n',
    );
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+39 333', "'+39 333"],
    ['-prova', "'-prova"],
    ['@SOMMA', "'@SOMMA"],
    ['Bar Esempio', 'Bar Esempio'],
    [null, ''],
  ])('il testo %s non diventa una formula', (text, expected) => {
    expect(csvText(text)).toBe(expected);
  });

  it('date all\'italiana', () => {
    expect(italianDate('2026-10-05')).toBe('05/10/2026');
  });
});

describe('reminderIcs', () => {
  const ics = reminderIcs('abc', 'Disdire Servizio, annuale; prova', '2026-12-31', new Date('2026-11-02T10:00:00Z'));

  it('evento di un giorno con avviso 3 giorni prima', () => {
    const lines = ics.split('\r\n');
    expect(lines).toContain('UID:abc@bilancio');
    expect(lines).toContain('DTSTAMP:20261102T100000Z');
    expect(lines).toContain('DTSTART;VALUE=DATE:20261231');
    expect(lines).toContain('DTEND;VALUE=DATE:20270101');
    expect(lines).toContain('TRIGGER:-P3D');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
  });

  it('protegge i caratteri speciali e spezza le righe lunghe', () => {
    expect(ics).toContain('SUMMARY:Disdire Servizio\\, annuale\\; prova');
    const long = reminderIcs('abc', 'x'.repeat(200), '2026-12-31');
    for (const line of long.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
    expect(long.replace(/\r\n /g, '')).toContain('SUMMARY:' + 'x'.repeat(200));
  });
});
