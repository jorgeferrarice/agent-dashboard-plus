import React, { useEffect, useState, useRef } from 'react';
import { flushSync } from 'react-dom';
import { Info } from 'lucide-react';
import { updateTaskDescription } from '../../api';

/**
 * Inline-editable task description. Click to edit, Enter to
 * save, Escape to cancel. Blurring also saves.
 */
const EditableTaskDescription: React.FC<{
  agentId: string;
  description: string;
}> = ({ agentId, description }) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep local value in sync with prop changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync prop to local state
    if (!editing) setValue(description);
  }, [description, editing]);

  /**
   * Swaps the text for the input and focuses it inside the tap
   * itself. Phones only raise the on-screen keyboard for a
   * focus() made while the tap is being handled; an effect
   * runs after the handler returns, which is too late there.
   */
  const startEditing = () => {
    flushSync(() => setEditing(true));
    inputRef.current?.focus();
  };

  const save = async () => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed !== description) {
      try {
        await updateTaskDescription(agentId, trimmed);
      } catch (err) {
        console.error('Failed to update task description:', err);
        setValue(description);
      }
    }
  };

  const cancel = () => {
    setValue(description);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') cancel();
        }}
        onBlur={save}
        enterKeyHint="done"
        className="w-full bg-slate-800 text-[11px] text-slate-200 px-1.5 py-0.5 rounded border border-accent-muted outline-none focus:border-accent"
        placeholder="Describe the task..."
      />
    );
  }

  return (
    <p
      className="text-[11px] text-slate-300 line-clamp-2 leading-relaxed cursor-pointer hover:text-slate-100 transition-colors"
      onClick={startEditing}
      title="Click to edit task description"
    >
      <Info size={10} className="inline mr-1 text-slate-500" />
      {description || 'Add a description...'}
    </p>
  );
};

export default EditableTaskDescription;
