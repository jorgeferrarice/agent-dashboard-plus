import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n';
import { SOUNDS, loadSound, playSound, saveSound } from './tabs/sound';
import type { SoundChoice, SoundKind } from './tabs/sound';

const LABELS: Record<SoundKind, MessageKey> = {
  chime: 'sound.chime',
  ping: 'sound.ping',
  double: 'sound.double',
  soft: 'sound.soft',
};

/**
 * Picks the sound played when a session has waited for the user
 * for a minute, or turns it off. Picking a sound plays it; ▶
 * plays it again. The choice is kept in this browser.
 */
const SoundSelector: React.FC = () => {
  const { t } = useI18n();
  const [choice, setChoice] = useState<SoundChoice>(loadSound);
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={t('settings.sound')}
        value={choice}
        onChange={(e) => {
          const next = e.target.value as SoundChoice;
          setChoice(next);
          saveSound(next);
          if (next !== 'off') playSound(next);
        }}
        className="flex-1 min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
      >
        <option value="off">{t('sound.off')}</option>
        {SOUNDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(LABELS[kind])}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={choice === 'off'}
        onClick={() => choice !== 'off' && playSound(choice)}
        aria-label={t('sound.test')}
        title={t('sound.test')}
        className="shrink-0 w-8 h-8 pointer-fine:w-7 pointer-fine:h-7 flex items-center justify-center rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
      >
        <Play size={12} />
      </button>
    </div>
  );
};

export default SoundSelector;
