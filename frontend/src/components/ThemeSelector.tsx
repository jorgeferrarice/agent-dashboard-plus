/**
 * Compact row of coloured dots for switching themes.
 *
 * Each dot is filled with the theme's `dotColor`.  The
 * active theme gets a white ring and a slight scale-up.
 * The "space-black" dot always renders a subtle gray
 * border so it stays visible on dark backgrounds.
 */

import React from 'react';
import { THEMES } from '../theme/themeValues';
import type { ThemeKey } from '../theme/themeValues';
import { useTheme } from '../theme/ThemeContext';

const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];

const ThemeSelector: React.FC = () => {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center gap-3 sm:gap-2">
      {THEME_KEYS.map((key) => {
        const def = THEMES[key];
        const isActive = key === theme;
        const isSpaceBlack = key === 'space-black';

        return (
          <button
            key={key}
            type="button"
            title={def.label}
            aria-label={`Switch to ${def.label} theme`}
            onClick={() => setTheme(key)}
            className={[
              'w-5 h-5 pointer-fine:w-4 pointer-fine:h-4 rounded-full transition-all',
              // A finger-sized hit area around the small dot.
              "relative after:absolute after:-inset-2 after:content-['']",
              'cursor-pointer',
              isActive ? 'ring-2 ring-white scale-125' : 'hover:scale-110',
              isSpaceBlack && !isActive ? 'ring-1 ring-slate-500' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ backgroundColor: def.dotColor }}
          />
        );
      })}
    </div>
  );
};

export default ThemeSelector;
