import { clampPanelWidth, modelPillLabel, PANEL_MIN_WIDTH } from './protocol';

describe('protocol helpers', () => {
  it('formats the composer pill', () => {
    expect(modelPillLabel({ model: 'opus', effort: 'medium' })).toBe('Opus 5.5 · Med');
    expect(modelPillLabel({ model: 'weird', effort: 'high' })).toBe('weird · High');
  });
  it('clamps panel width to [min, 60% of work area]', () => {
    expect(clampPanelWidth(10, 1920)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(5000, 1920)).toBe(1100);
    expect(clampPanelWidth(500, 1000)).toBe(500);
    expect(clampPanelWidth(Number.NaN, 1920)).toBe(440);
  });
});
