import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = "claude-tree:theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

// localStorage can throw (e.g. storage disabled), so treat any failure as
// "no saved choice" rather than crashing the app over a cosmetic setting.
function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Choice just won't survive a reload.
  }
}

const systemTheme = (): Theme => (darkQuery.matches ? 'dark' : 'light');

/**
 * The app's light/dark theme, applied as `data-theme` on <html> (which
 * index.css keys its color variables off). Follows the OS setting until the
 * user toggles it, after which their choice is remembered in localStorage and
 * wins over the OS from then on.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [storedTheme, setStoredTheme] = useState<Theme | null>(readStoredTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = storedTheme ?? system;

  useEffect(() => {
    const onChange = () => setSystem(systemTheme());
    darkQuery.addEventListener('change', onChange);
    return () => darkQuery.removeEventListener('change', onChange);
  }, []);

  // Layout effect so the attribute is set before the first paint — otherwise
  // a dark-mode user who saved "light" (or vice versa) would see a flash.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    storeTheme(next);
    setStoredTheme(next);
  }, [theme]);

  return { theme, toggleTheme };
}
