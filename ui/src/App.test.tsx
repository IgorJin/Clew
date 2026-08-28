import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { fixtureTasks } from './fixtures';
import type { ThreadItem } from './types';

const api = vi.hoisted(() => ({
  execute: vi.fn(async () => ({ fixture: true })),
  loadTasks: vi.fn(async () => ({ tasks: structuredClone(fixtureTasks), state: 'fixture' })),
  subscribeToEvents: vi.fn(() => () => undefined),
}));

vi.mock('./api', () => api);

import App, { Thread } from './App';

describe('Preact control plane', () => {
  it('confirms completion and sends the pinned revision', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /complete/i }));

    expect(api.execute).toHaveBeenCalledWith(['complete', 'CLEW-071', '--revision', 'a91c4e2']);
    expect(await screen.findByText('Task completed')).toBeTruthy();
  });

  it('continues READY work with the operator message instead of retrying', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    const message = await screen.findByRole('textbox', { name: /add a message/i });

    fireEvent.input(message, { target: { value: 'Please address the remaining edge case' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(api.execute).toHaveBeenCalledWith([
      'continue',
      'CLEW-071',
      '--message',
      'Please address the remaining edge case',
    ]);
    expect(await screen.findByText('Continuation requested')).toBeTruthy();
  });

  it('approves a plan and exposes the durable fixture state', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /parallel cache migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /approve plan/i }));

    expect(api.execute).toHaveBeenCalledWith(['approve', 'ACC-DEEP']);
    expect((await screen.findAllByText('Plan ready')).length).toBeGreaterThan(0);
  });

  it('renders summaries as text instead of arbitrary HTML', () => {
    const item: ThreadItem = {
      version: 1,
      id: 'hostile',
      cursor: 1,
      kind: 'operator_message',
      at: '2026-08-28T09:42:00.000Z',
      source: { kind: 'operator', id: 'local-user' },
      summary: '<img src=x onerror="window.compromised=true">',
    };

    const { container } = render(<Thread items={[item]} />);

    expect(screen.getByText(item.summary)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
});
