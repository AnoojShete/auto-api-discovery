import { describe, it, expect } from 'vitest';
import {
  getRealisticLaunchOptions,
  getRealisticContextOptions,
  getPersistentLaunchArgs,
} from '../src/capture/realism';

describe('realism helper', () => {
  it('generates correct launch options for headless', () => {
    const opts = getRealisticLaunchOptions(false);
    expect(opts.headless).toBe(true);
    expect(opts.args).toContain('--disable-blink-features=AutomationControlled');
    expect(opts.args).not.toContain('--start-maximized');
  });

  it('generates correct launch options for headed', () => {
    const opts = getRealisticLaunchOptions(true);
    expect(opts.headless).toBe(false);
    expect(opts.args).toContain('--start-maximized');
  });

  it('generates realistic context options', () => {
    const storageMock = { cookies: [], origins: [] };
    const opts = getRealisticContextOptions(storageMock);

    expect(opts.viewport).toEqual({ width: 1920, height: 1080 });
    expect(opts.userAgent).toContain('Chrome');
    expect(opts.colorScheme).toBe('dark');
    expect(opts.locale).toBe('en-US');
    expect(opts.storageState).toBe(storageMock);
    expect(opts.permissions).toContain('geolocation');
  });

  it('persistent launch args include automation control disable', () => {
    const args = getPersistentLaunchArgs(true);
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).toContain('--start-maximized');
  });
});
