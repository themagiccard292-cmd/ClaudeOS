import { deriveTitle, formatBytes, formatRelativeTime, truncate } from './format';
import { computeDragWidth } from './resize';

describe('format helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12_870)).toBe('13 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('formats relative time', () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now - 10_000, now)).toBe('now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatRelativeTime(now - 30 * 3_600_000, now)).toBe('Yesterday');
    expect(formatRelativeTime(now - 4 * 86_400_000, now)).toBe('4d');
  });

  it('derives titles of about 40 characters on a word boundary', () => {
    expect(deriveTitle('  Hello   world ')).toBe('Hello world');
    const t = deriveTitle('Please organise every single file in my Downloads folder by type');
    expect(t.length).toBeLessThanOrEqual(41);
    expect(t.endsWith('…')).toBe(true);
    expect(t).toBe('Please organise every single file in my…');
    expect(deriveTitle('', ['a.pdf'])).toBe('Attached a.pdf');
    expect(deriveTitle('')).toBe('New chat');
  });

  it('truncates', () => {
    expect(truncate('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncate('ab', 3)).toEqual({ text: 'ab', truncated: false });
  });

  it('computes drag width: dragging left widens', () => {
    expect(computeDragWidth(440, 1000, 900)).toBe(540);
    expect(computeDragWidth(440, 1000, 1100)).toBe(340);
    expect(computeDragWidth(440, 1000, 1000)).toBe(440);
  });
});
