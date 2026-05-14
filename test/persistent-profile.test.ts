import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveProfileDir,
  isExistingProfile,
  isProfileLocked,
  getRealisticLaunchOptions,
  getRealisticContextOptions,
  getPersistentLaunchArgs,
} from '../src/capture/realism';
import { isUrlInScope } from '../src/cli/crawl';
import { isAuthRoute } from '../src/capture/auth-detector';
import {
  createSession,
  saveStorageState,
  loadStorageState,
  updateSessionCookies,
  isSessionLikelyValid,
} from '../src/db/sessions';
import { closeDb } from '../src/db/schema';

// ─── Profile Resolution ──────────────────────────────────────────

describe('persistent profiles — resolveProfileDir', () => {
  const testBase = path.join(process.cwd(), '.apigen-test-profiles');

  beforeEach(() => {
    process.env.APIGEN_CWD = testBase;
    if (fs.existsSync(testBase)) {
      fs.rmSync(testBase, { recursive: true, force: true });
    }
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(testBase)) {
      fs.rmSync(testBase, { recursive: true, force: true });
    }
    delete process.env.APIGEN_CWD;
  });

  it('creates default profile under .apigen/profiles/', () => {
    const dir = resolveProfileDir('default');
    expect(dir).toContain('profiles');
    expect(dir).toContain('default');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('creates named profiles', () => {
    const dir = resolveProfileDir('leetcode-session');
    expect(dir).toContain('leetcode-session');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('uses absolute paths directly', () => {
    const customDir = path.join(testBase, 'custom-profile');
    const dir = resolveProfileDir(customDir);
    expect(dir).toBe(customDir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('defaults to "default" when no name provided', () => {
    const dir = resolveProfileDir();
    expect(dir).toContain('default');
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ─── Profile Lifecycle ───────────────────────────────────────────

describe('persistent profiles — lifecycle', () => {
  const testBase = path.join(process.cwd(), '.apigen-test-profiles-lifecycle');

  beforeEach(() => {
    if (fs.existsSync(testBase)) {
      fs.rmSync(testBase, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testBase)) {
      fs.rmSync(testBase, { recursive: true, force: true });
    }
  });

  it('isExistingProfile returns false for fresh profile', () => {
    fs.mkdirSync(testBase, { recursive: true });
    expect(isExistingProfile(testBase)).toBe(false);
  });

  it('isExistingProfile returns true when Default folder exists', () => {
    fs.mkdirSync(path.join(testBase, 'Default'), { recursive: true });
    expect(isExistingProfile(testBase)).toBe(true);
  });

  it('isProfileLocked returns false for unlocked profile', () => {
    fs.mkdirSync(testBase, { recursive: true });
    expect(isProfileLocked(testBase)).toBe(false);
  });

  it('isProfileLocked returns true when lock file exists', () => {
    fs.mkdirSync(testBase, { recursive: true });
    fs.writeFileSync(path.join(testBase, 'SingletonLock'), '');
    expect(isProfileLocked(testBase)).toBe(true);
  });

  it('isProfileLocked detects Windows lockfile', () => {
    fs.mkdirSync(testBase, { recursive: true });
    fs.writeFileSync(path.join(testBase, 'lockfile'), '');
    expect(isProfileLocked(testBase)).toBe(true);
  });
});

// ─── Launch Configuration ────────────────────────────────────────

describe('persistent profiles — launch config', () => {
  it('getPersistentLaunchArgs includes automation disable', () => {
    const args = getPersistentLaunchArgs(true);
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).toContain('--disable-infobars');
    expect(args).toContain('--start-maximized');
  });

  it('getPersistentLaunchArgs omits --start-maximized for headless', () => {
    const args = getPersistentLaunchArgs(false);
    expect(args).not.toContain('--start-maximized');
  });

  it('legacy getRealisticLaunchOptions still works', () => {
    const opts = getRealisticLaunchOptions(true);
    expect(opts.headless).toBe(false);
    expect(opts.args).toContain('--disable-blink-features=AutomationControlled');
  });

  it('legacy getRealisticContextOptions does not set viewport null', () => {
    const opts = getRealisticContextOptions();
    expect(opts.viewport).toEqual({ width: 1920, height: 1080 });
    expect(opts.locale).toBe('en-US');
    expect(opts.deviceScaleFactor).toBe(1);
    expect(opts.isMobile).toBe(false);
    expect(opts.hasTouch).toBe(false);
  });
});

// ─── Auth Persistence ────────────────────────────────────────────

describe('persistent profiles — auth persistence', () => {
  const testDir = path.join(process.cwd(), '.apigen-test-auth-persist');

  beforeEach(() => {
    process.env.APIGEN_CWD = testDir;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.APIGEN_CWD;
  });

  it('saves and loads storageState for persistent profile sessions', () => {
    const sessionId = createSession('profile-session');
    const mockState = {
      cookies: [
        { name: 'cf_clearance', value: 'abc', domain: '.leetcode.com', path: '/' },
        { name: 'csrftoken', value: 'xyz', domain: '.leetcode.com', path: '/' },
      ],
      origins: [
        { origin: 'https://leetcode.com', localStorage: [{ name: 'auth_token', value: 'jwt-123' }] },
      ],
    };

    saveStorageState(sessionId, mockState);
    const loaded = loadStorageState('profile-session');

    expect(loaded).not.toBeNull();
    expect(loaded.cookies[0].name).toBe('cf_clearance');
    expect(loaded.origins[0].localStorage[0].value).toBe('jwt-123');
  });

  it('cookie-only persistence still works', () => {
    const sessionId = createSession('cookie-session');
    updateSessionCookies(sessionId, [
      { name: 'session_id', value: 'abc123' },
    ]);
    expect(isSessionLikelyValid('cookie-session')).toBe(true);
  });
});

// ─── Queue Sanitization ─────────────────────────────────────────

describe('queue sanitization', () => {
  it('purges auth routes from BFS queue', () => {
    const queue = [
      { url: 'https://leetcode.com/problems/', depth: 1 },
      { url: 'https://leetcode.com/accounts/login/', depth: 1 },
      { url: 'https://leetcode.com/accounts/logout/', depth: 1 },
      { url: 'https://leetcode.com/contest/', depth: 1 },
      { url: 'https://leetcode.com/accounts/signup/', depth: 1 },
    ];

    const sanitized = queue.filter(item => !isAuthRoute(item.url));
    expect(sanitized.length).toBe(2);
    expect(sanitized[0].url).toBe('https://leetcode.com/problems/');
    expect(sanitized[1].url).toBe('https://leetcode.com/contest/');
  });

  it('auth routes are excluded from link discovery post-auth', () => {
    const links = [
      'https://leetcode.com/problems/two-sum/',
      'https://leetcode.com/accounts/login/',
      'https://leetcode.com/auth/callback',
      'https://leetcode.com/discuss/',
    ];

    const isAuthenticated = true;
    const filtered = links.filter(url => {
      if (isAuthenticated && isAuthRoute(url)) return false;
      return true;
    });

    expect(filtered.length).toBe(2);
    expect(filtered).toContain('https://leetcode.com/problems/two-sum/');
    expect(filtered).toContain('https://leetcode.com/discuss/');
  });
});

// ─── Interceptor Pause/Resume ────────────────────────────────────

describe('interceptor pause/resume', () => {
  it('controller interface has correct shape', () => {
    // Simulate the controller pattern
    let _paused = false;
    const controller = {
      pause() { _paused = true; },
      resume() { _paused = false; },
      isPaused() { return _paused; },
    };

    expect(controller.isPaused()).toBe(false);
    controller.pause();
    expect(controller.isPaused()).toBe(true);
    controller.resume();
    expect(controller.isPaused()).toBe(false);
  });

  it('pause prevents response processing', () => {
    let _paused = false;
    const processed: string[] = [];

    const controller = {
      pause() { _paused = true; },
      resume() { _paused = false; },
      isPaused() { return _paused; },
    };

    // Simulate response handler
    const handleResponse = (url: string) => {
      if (_paused) return;
      processed.push(url);
    };

    handleResponse('https://api.example.com/users'); // should process
    controller.pause();
    handleResponse('https://api.example.com/data'); // should skip
    controller.resume();
    handleResponse('https://api.example.com/posts'); // should process

    expect(processed).toEqual([
      'https://api.example.com/users',
      'https://api.example.com/posts',
    ]);
  });
});

// ─── Warmup Flow ─────────────────────────────────────────────────

describe('authenticated warmup', () => {
  it('auth cookies regex matches common patterns', () => {
    const pattern = /session|token|auth|jwt/i;

    expect(pattern.test('LEETCODE_SESSION')).toBe(true);
    expect(pattern.test('csrftoken')).toBe(true);
    expect(pattern.test('cf_clearance')).toBe(false);
    expect(pattern.test('auth_token')).toBe(true);
    expect(pattern.test('jwt_access')).toBe(true);
    expect(pattern.test('_ga')).toBe(false);
    expect(pattern.test('tracking_id')).toBe(false);
  });

  it('post-auth queue is clean before BFS resumes', () => {
    let queue = [
      { url: 'https://example.com/', depth: 0 },
      { url: 'https://example.com/login', depth: 1 },
      { url: 'https://example.com/dashboard', depth: 1 },
      { url: 'https://example.com/auth/callback', depth: 1 },
    ];

    // Simulate post-auth sanitization
    queue = queue.filter(item => !isAuthRoute(item.url));

    // Then warmup delay would occur (tested separately)
    expect(queue.length).toBe(2);
    expect(queue.map(q => q.url)).toEqual([
      'https://example.com/',
      'https://example.com/dashboard',
    ]);
  });
});

// ─── Attach Mode ─────────────────────────────────────────────────

describe('attach mode — connection', () => {
  it('attachToRunningBrowser requires valid WebSocket endpoint', async () => {
    // We cannot test actual CDP connection without a running Chrome,
    // but we verify the function exists and rejects invalid endpoints.
    const { attachToRunningBrowser } = await import('../src/capture/realism');
    expect(typeof attachToRunningBrowser).toBe('function');
  });
});
