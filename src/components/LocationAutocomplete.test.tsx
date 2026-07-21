import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocationAutocomplete } from './LocationAutocomplete';

describe('LocationAutocomplete', () => {
  it('renders an input with the supplied value', () => {
    render(<LocationAutocomplete value="van" onChange={() => {}} />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('van');
  });

  it('does not show the suggestion list when input is empty', () => {
    render(<LocationAutocomplete value="" onChange={() => {}} />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not show the suggestion list on mount, even with non-empty value', () => {
    render(<LocationAutocomplete value="van" onChange={() => {}} />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens the suggestion list when the input is focused', () => {
    render(<LocationAutocomplete value="van" onChange={() => {}} />);
    fireEvent.focus(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('opens the suggestion list when the user types', () => {
    const onChange = vi.fn();
    render(<LocationAutocomplete value="va" onChange={onChange} />);
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'van' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('fires onChange on every keystroke', () => {
    const onChange = vi.fn();
    render(<LocationAutocomplete value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'van' } });
    expect(onChange).toHaveBeenCalledWith('van');
  });

  it('ArrowDown highlights the first suggestion, Enter accepts it', () => {
    const onChange = vi.fn();
    render(<LocationAutocomplete value="van" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // onChange should be called with a non-empty hierarchical string.
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(lastCall.length).toBeGreaterThan(0);
  });

  it('Escape closes the dropdown but preserves the typed value', () => {
    const onChange = vi.fn();
    render(<LocationAutocomplete value="van" onChange={onChange} />);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('mousing down a suggestion accepts it', () => {
    const onChange = vi.fn();
    render(<LocationAutocomplete value="van" onChange={onChange} />);
    fireEvent.focus(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option');
    fireEvent.mouseDown(options[0]);
    expect(onChange).toHaveBeenCalled();
  });

  it('shows an empty state when no matches exist after focus', () => {
    render(<LocationAutocomplete value="xyzzzz" onChange={() => {}} />);
    fireEvent.focus(screen.getByRole('combobox'));
    expect(screen.getByText(/no matches/i)).toBeTruthy();
  });
});
