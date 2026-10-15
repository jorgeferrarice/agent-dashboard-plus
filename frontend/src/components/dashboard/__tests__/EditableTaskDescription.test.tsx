import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EditableTaskDescription from '../EditableTaskDescription';

vi.mock('../../../api', () => ({
  updateTaskDescription: vi.fn(async () => undefined),
}));

describe('EditableTaskDescription', () => {
  it('focuses the input inside the click that starts editing', () => {
    render(<EditableTaskDescription agentId="a" description="fix bug" />);
    // The focus must not wait for an effect or a later frame:
    // a phone only shows its keyboard for a focus made in the tap.
    fireEvent.click(screen.getByText('fix bug'));
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('fix bug');
    expect(input).toHaveFocus();
  });
});
