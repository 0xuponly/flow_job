import { useState } from 'react';
import { LocationAutocomplete } from './LocationAutocomplete';
import type { LocationNode, LocationPick } from '../locations';

interface Props {
  value: LocationPick[];
  onChange: (picks: LocationPick[]) => void;
  placeholder?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
}

/**
 * Multi-location input. Renders the current picks as a vertical list of
 * pills with a × remove button, plus a single LocationAutocomplete as
 * the add input. Picking a node appends {id, display} and clears the
 * input. Pressing Enter on free text (no highlighted suggestion) or
 * blurring the input appends {display} and clears.
 *
 * Replaces the old multiSegment LocationAutocomplete which joined
 * picks with ", " — that join was ambiguous with the internal ", " of
 * a single full location display, so it was the source of the
 * comma-splitting bug.
 */
export function LocationPicker({ value, onChange, placeholder, id, className, ariaLabel }: Props) {
  const [draft, setDraft] = useState('');

  function commit(node: LocationNode | null) {
    const text = draft.trim();
    if (!text) return;
    const next: LocationPick = node
      ? { id: node.id, display: node.display() }
      : { display: text };
    onChange([...value, next]);
    setDraft('');
  }

  return (
    <div className={`location-picker ${className ?? ''}`}>
      {value.length > 0 && (
        <ul className="location-picker-list" aria-label={ariaLabel ?? 'Selected locations'}>
          {value.map((p, i) => (
            <li key={`${p.id ?? 'free'}-${i}`} className="location-picker-pill">
              <span className="location-picker-pill-text">{p.display}</span>
              <button
                type="button"
                className="location-picker-remove"
                aria-label={`Remove ${p.display}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <LocationAutocomplete
        value={draft}
        onChange={setDraft}
        onPick={node => commit(node)}
        onBlur={() => commit(null)}
        onKeyDownFreeText={() => commit(null)}
        placeholder={placeholder ?? 'Add a location'}
        id={id}
        ariaLabel={ariaLabel ? `${ariaLabel} (add)` : 'Add a location'}
      />
    </div>
  );
}
