import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { type MockApi, type MockOptions, createMockApi } from '../dev/mockApi';
import { SettingsProvider } from '../state/settings';

/** Install a fresh, fast in-memory `window.claudeos` for one test. */
export function installMock(options: MockOptions = {}): MockApi {
  const mock = createMockApi({ tickMs: 0, ...options });
  window.claudeos = mock;
  return mock;
}

export function renderWithSettings(ui: ReactElement): RenderResult {
  // As a wrapper so `rerender` keeps the provider.
  return render(ui, { wrapper: SettingsProvider });
}
