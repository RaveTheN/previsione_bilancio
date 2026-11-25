/** Tema scelto in Altro e salvato sul dispositivo; i due colori sono quelli della barra del browser, in chiaro e in scuro. */
const BAR = { classico: ['#f8fafc', '#0b1120'], maialino: ['#fff8f0', '#161309'] };

export type Theme = keyof typeof BAR;

export function currentTheme(): Theme {
  return localStorage.getItem('tema') === 'maialino' ? 'maialino' : 'classico';
}

export function applyTheme(theme: Theme = currentTheme()): void {
  localStorage.setItem('tema', theme);
  document.documentElement.classList.toggle('tema-maialino', theme === 'maialino');
  document.querySelectorAll('meta[name=theme-color]').forEach((m, i) => m.setAttribute('content', BAR[theme][i]));
}
