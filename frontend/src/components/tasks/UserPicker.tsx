import React, { useEffect, useState } from 'react';
import { errorMessage, searchUsers } from '../../tasksApi';
import type { Choice } from '../../tasksApi';
import { fieldClass } from './taskDraft';
import { useI18n } from '../../i18n';

interface UserPickerProps {
  taskId: string;
  label: string;
  value: Choice | null;
  onChange: (user: Choice | null) => void;
}

/**
 * Picks a person a tracker's task can be assigned to: type
 * part of a name, then pick from the matches.
 */
const UserPicker: React.FC<UserPickerProps> = ({
  taskId,
  label,
  value,
  onChange,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Choice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Ask the tracker a moment after the user stops typing.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchUsers(taskId, query)
        .then((found) => {
          if (cancelled) return;
          setMatches(found);
          setError(null);
        })
        .catch((err) => !cancelled && setError(errorMessage(err)));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [taskId, query, open]);

  return (
    <div className="text-xs text-slate-400">
      <label className="block">
        {label}
        <input
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-autocomplete="list"
          value={open ? query : (value?.name ?? '')}
          placeholder={t('tasks.typeName')}
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => setQuery(e.target.value)}
          className={`mt-1 ${fieldClass}`}
        />
      </label>
      {open && (
        <ul
          role="listbox"
          aria-label={t('tasks.matches', { label })}
          className="mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-700 bg-slate-950"
        >
          {matches.map((user) => (
            <li key={user.id}>
              <button
                type="button"
                role="option"
                aria-selected={value?.id === user.id}
                // Before the input's blur closes the list.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(user);
                  setOpen(false);
                }}
                className="block w-full px-2.5 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-800"
              >
                {user.name}
              </button>
            </li>
          ))}
          {matches.length === 0 && !error && (
            <li className="px-2.5 py-1.5 text-slate-500">
              {t('tasks.noMatches')}
            </li>
          )}
          {error && <li className="px-2.5 py-1.5 text-red-400">{error}</li>}
        </ul>
      )}
    </div>
  );
};

export default UserPicker;
