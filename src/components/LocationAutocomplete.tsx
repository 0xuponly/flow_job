import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { findByPrefix, type LocationNode } from '../locations';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onPick?: (node: LocationNode) => void;
  onBlur?: () => void;
  onKeyDownFreeText?: (text: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
};

export function LocationAutocomplete({
  value,
  onChange,
  onPick,
  onBlur,
  onKeyDownFreeText,
  placeholder,
  id,
  className,
  ariaLabel,
}: Props) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const listboxId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const matches = useMemo(() => {
    if (!value.trim()) return [];
    return findByPrefix(value, 10);
  }, [value]);

  const hasNoMatches = value.trim().length > 0 && matches.length === 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Reset highlight when the match set changes.
  useEffect(() => {
    setHighlight(0);
  }, [value]);

  const showList = open && value.trim().length > 0;

  function commitPick(node: LocationNode) {
    onPick?.(node);
    onChange(node.display());
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (matches.length > 0) setHighlight((h) => (h + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length > 0) setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      if (showList && matches[highlight]) {
        e.preventDefault();
        commitPick(matches[highlight]);
      } else if (value.trim()) {
        e.preventDefault();
        onKeyDownFreeText?.(value.trim());
        onChange('');
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Tab') {
      if (showList && matches[highlight]) {
        commitPick(matches[highlight]);
      }
    }
  }

  return (
    <div ref={containerRef} className={`location-autocomplete ${className ?? ''}`}>
      <input
        ref={inputRef}
        id={inputId}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={showList && matches[highlight] ? `${listboxId}-${highlight}` : undefined}
        aria-label={ariaLabel}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => onBlur?.()}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          className="location-suggestion-list"
        >
          {hasNoMatches ? (
            <li className="location-suggestion-empty">No matches — type to add free text</li>
          ) : (
            matches.map((m, i) => (
              <li
                key={m.id}
                id={`${listboxId}-${i}`}
                role="option"
                aria-selected={i === highlight}
                className={`location-suggestion ${i === highlight ? 'location-suggestion--active' : ''}`}
                onMouseDown={(e) => {
                  // mousedown so the input doesn't lose focus first
                  e.preventDefault();
                  commitPick(m);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="location-suggestion-name">{m.name}</span>
                <span className="location-suggestion-meta">{suggestionMeta(m)}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function suggestionMeta(m: LocationNode): string {
  if (m.type === 'country') return 'country';
  if (m.type === 'city' || m.type === 'state' || m.type === 'province') {
    // Strip the leading "Name, " from the full display string.
    const full = m.display();
    const idx = full.indexOf(', ');
    const rest = idx === -1 ? '' : full.slice(idx + 2);
    return rest ? `${m.type} · ${rest}` : m.type;
  }
  return m.type;
}
