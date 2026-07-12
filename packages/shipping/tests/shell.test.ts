import { describe, it, expect } from 'vitest';
import { renderElectronMain, packageJsonForApp } from '../src/shell.js';

describe('renderElectronMain', () => {
  const opts = { width: 1280, height: 720, title: 'My Game' };

  it('hardens the BrowserWindow webPreferences', () => {
    const js = renderElectronMain(opts);
    expect(js).toMatch(/contextIsolation:\s*true/);
    expect(js).toMatch(/nodeIntegration:\s*false/);
    expect(js).not.toMatch(/preload/);
  });

  it('interpolates width, height and title via JSON.stringify escaping', () => {
    const js = renderElectronMain(opts);
    expect(js).toContain(`width: ${JSON.stringify(opts.width)}`);
    expect(js).toContain(`height: ${JSON.stringify(opts.height)}`);
    expect(js).toContain(`title: ${JSON.stringify(opts.title)}`);
  });

  it('sets useContentSize and loads index.html via loadFile', () => {
    const js = renderElectronMain(opts);
    expect(js).toMatch(/useContentSize:\s*true/);
    expect(js).toMatch(/loadFile\(\s*(['"`])index\.html\1/);
  });

  it('toggles fullscreen on F11 and Cmd/Ctrl+F', () => {
    const js = renderElectronMain(opts);
    expect(js).toContain('F11');
    expect(js).toMatch(/CommandOrControl\+F/);
    expect(js).toMatch(/setFullScreen/);
  });

  it('quits on window-all-closed', () => {
    const js = renderElectronMain(opts);
    expect(js).toContain("app.on('window-all-closed', () => app.quit())");
  });

  it('denies external navigation via will-navigate and setWindowOpenHandler', () => {
    const js = renderElectronMain(opts);
    expect(js).toMatch(/will-navigate/);
    expect(js).toMatch(/setWindowOpenHandler/);
    expect(js).toMatch(/deny/);
  });

  it('leaves no template placeholders in the output', () => {
    const js = renderElectronMain(opts);
    expect(js).not.toContain('{{');
  });

  it('safely escapes a title containing quotes and a closing script tag', () => {
    const dangerous = { width: 800, height: 600, title: `"</script><script>alert(1)</script>` };
    const js = renderElectronMain(dangerous);
    // JSON.stringify escapes the double quotes; the raw sequence must not
    // appear unescaped anywhere the string is embedded.
    expect(js).toContain(`title: ${JSON.stringify(dangerous.title)}`);
    expect(js).not.toContain('"</script><script>alert(1)</script>"title:');
    expect(js).not.toContain('{{');
    // The generated source itself must remain syntactically valid JS —
    // Function() throws a SyntaxError if the interpolation broke out of the
    // string literal.
    expect(() => new Function(js)).not.toThrow();
  });

  it('produces valid JS for the default (non-adversarial) case', () => {
    const js = renderElectronMain(opts);
    expect(() => new Function(js)).not.toThrow();
  });
});

describe('packageJsonForApp', () => {
  it('produces a minimal package.json with main set to main.js', () => {
    const json = packageJsonForApp({ name: 'My Game' });
    const parsed = JSON.parse(json);
    expect(parsed.main).toBe('main.js');
    expect(parsed.name).toBe('my-game');
  });

  it('slugifies the app name', () => {
    const json = packageJsonForApp({ name: 'Cool Game!! 2' });
    const parsed = JSON.parse(json);
    expect(parsed.name).toMatch(/^[a-z0-9-]+$/);
  });

  it('defaults version to 1.0.0 when not provided', () => {
    const json = packageJsonForApp({ name: 'My Game' });
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe('1.0.0');
  });

  it('uses the provided version when given', () => {
    const json = packageJsonForApp({ name: 'My Game', version: '2.3.4' });
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe('2.3.4');
  });
});
