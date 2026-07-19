import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { findByPrefix, type LocationNode } from '../locations';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onPick?: (node: LocationNode) => void;
  placeholder?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  multiSegment?: boolean;
};

export function LocationAutocomplete({
  value,
  onChange,
  onPick,
  placeholder,
  id,
  className,
  ariaLabel,
  multiSegment = false,
}: Props) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const listboxId = `${inputId}-listbox`;

  // Split value into prefix (everything up to and including the last ", ")
  // and the current segment being edited. When multiSegment is false, the
  // whole value is the current segment.
  const { prefix, currentSegment } = useMemo(() => {
    if (!multiSegment) return { prefix: '', currentSegment: value };
    const idx = value.lastIndexOf(', ');
    if (idx === -1) return { prefix: '', currentSegment: value };
    return { prefix: value.slice(0, idx + 2), currentSegment: value.slice(idx + 2) };
  }, [value, multiSegment]);

  const [open, setOpen] = useState(currentSegment.trim().length > 0);
  const [highlight, setHighlight] = useState(0);

  const matches = useMemo(() => {
    if (!currentSegment.trim()) return [];
    return findByPrefix(currentSegment, 10);
  }, [currentSegment]);

  const hasNoMatches = currentSegment.trim().length > 0 && matches.length === 0;

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
  }, [currentSegment]);

  const showList = open && currentSegment.trim().length > 0;

  function commitPick(node: LocationNode) {
    const next = multiSegment ? `${prefix}${node.display()}` : node.display();
    onChange(next);
    onPick?.(node);
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
                onClick={() => commitPick(m)}
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
