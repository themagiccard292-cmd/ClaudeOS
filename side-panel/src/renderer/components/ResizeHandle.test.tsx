import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installMock } from '../test/utils';
import { ResizeHandle } from './ResizeHandle';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => vi.unstubAllGlobals());

describe('ResizeHandle', () => {
  it('dragging left widens the panel, uses the clamped width and persists it', async () => {
    const mock = installMock();
    const setWidth = vi.spyOn(mock.panel, 'setWidth');
    render(<ResizeHandle initialWidth={440} />);
    const handle = screen.getByRole('separator', { name: 'Resize panel' });
    await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '440'));
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, screenX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 1, screenX: 950 });
    fireEvent.pointerMove(handle, { pointerId: 1, screenX: 900 }); // coalesced into one frame
    await waitFor(() => expect(setWidth).toHaveBeenCalledWith(540));
    expect(setWidth).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(handle, { pointerId: 1, screenX: -2000 }); // far beyond the max → main clamps
    await act(async () => {
      fireEvent.pointerUp(handle, { pointerId: 1, screenX: -2000 });
    });
    await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '1100'));
    expect(setWidth).toHaveBeenLastCalledWith(3440);
    expect(mock.mock.settings.panelWidth).toBe(1100);
  });

  it('double-click resets to 440 and arrow keys resize', async () => {
    const mock = installMock();
    const setWidth = vi.spyOn(mock.panel, 'setWidth');
    render(<ResizeHandle initialWidth={600} />);
    const handle = screen.getByRole('separator');
    fireEvent.doubleClick(handle);
    await waitFor(() => expect(setWidth).toHaveBeenCalledWith(440));
    await waitFor(() => expect(handle).toHaveAttribute('aria-valuenow', '440'));
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await waitFor(() => expect(setWidth).toHaveBeenLastCalledWith(456));
  });

  it('unsubscribes from panel state on unmount', () => {
    const mock = installMock();
    const { unmount } = render(<ResizeHandle />);
    expect(mock.mock.listenerCounts().state).toBe(1);
    unmount();
    expect(mock.mock.listenerCounts().state).toBe(0);
  });
});
