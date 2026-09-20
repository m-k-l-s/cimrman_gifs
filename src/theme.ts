export type Theme = 'system' | 'light' | 'dark';
const key = 'cimrman-theme';

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(key);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(key, theme);
  } catch { /* The theme still works without storage. */ }
}
