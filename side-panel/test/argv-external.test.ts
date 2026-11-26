import { parseLaunchArgs } from '../src/main/core/argv';
import { openExternalUrl, safeExternalUrl } from '../src/main/core/external';
import type { SpawnFn } from '../src/main/core/session-manager';

describe('parseLaunchArgs', () => {
  it('parses the C2 grammar, ignoring Chromium switches', () => {
    expect(parseLaunchArgs([], '/w')).toEqual({ background: false, request: null });
    expect(parseLaunchArgs(['--ozone-platform=x11', '--background'], '/w')).toEqual({ background: true, request: null });
    expect(parseLaunchArgs(['toggle', '--enable-features=X'], '/w')).toEqual({ background: false, request: { cmd: 'toggle' } });
    expect(parseLaunchArgs(['attach', '--', '-weird name', 'rel/x', '/abs'], '/home/u')).toEqual({
      background: false,
      request: { cmd: 'attach', paths: ['/home/u/-weird name', '/home/u/rel/x', '/abs'] },
    });
    expect(parseLaunchArgs(['ask', 'what', 'is', 'this', '--send', '--path', 'a.png', '--path=/b'], '/d')).toEqual({
      background: false,
      request: { cmd: 'ask', text: 'what is this', send: true, paths: ['/d/a.png', '/b'] },
    });
    expect(parseLaunchArgs(['--', 'toggle'], '/d').request).toBeNull();
  });
});

describe('external URLs', () => {
  it('only allows http(s)', () => {
    expect(safeExternalUrl('https://claude.ai/x?y=1')).toBe('https://claude.ai/x?y=1');
    expect(safeExternalUrl('http://example.com')).toBe('http://example.com/');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b', 'ftp://x', 'notaurl', '', 5, 'https://']) {
      expect(safeExternalUrl(bad)).toBeNull();
    }
  });
  it('spawns xdg-open detached with a sanitized env', () => {
    const calls: unknown[][] = [];
    const fake: SpawnFn = (c, a, o) => {
      calls.push([c, a, o.detached, o.env?.ANTHROPIC_API_KEY]);
      return { on: () => undefined, unref: () => undefined } as never;
    };
    expect(openExternalUrl('https://a.b/', fake, { ANTHROPIC_API_KEY: 'x', PATH: '/bin' })).toBe(true);
    expect(openExternalUrl('file:///x', fake)).toBe(false);
    expect(calls).toEqual([['xdg-open', ['https://a.b/'], true, undefined]]);
  });
});
