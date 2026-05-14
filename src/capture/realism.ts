/**
 * Browser realism and persistent profile management.
 *
 * Architecture: trust is identity-based. Authenticated Chrome profiles are
 * the source of trust. HITL establishes identity, automation explores after
 * trust exists.
 */

import { BrowserContext, BrowserContextOptions, LaunchOptions, chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { getApigenDir } from '../db/schema';

// ─── Profile Management ─────────────────────────────────────────

/**
 * Resolve a profile directory. Creates it if it does not exist.
 */
export function resolveProfileDir(profileNameOrPath?: string): string {
  if (!profileNameOrPath) profileNameOrPath = 'default';

  // If it looks like an absolute or relative path, use it directly
  if (path.isAbsolute(profileNameOrPath) || profileNameOrPath.includes(path.sep) || profileNameOrPath.includes('/')) {
    if (!fs.existsSync(profileNameOrPath)) {
      fs.mkdirSync(profileNameOrPath, { recursive: true });
    }
    return profileNameOrPath;
  }

  // Otherwise, treat as a named profile under .apigen/profiles/
  const profileDir = path.join(getApigenDir(), 'profiles', profileNameOrPath);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  return profileDir;
}

/**
 * Check if a profile directory already has browser state from a previous session.
 */
export function isExistingProfile(profileDir: string): boolean {
  // Chrome user data dirs contain a "Default" folder after first run
  const defaultDir = path.join(profileDir, 'Default');
  return fs.existsSync(defaultDir);
}

/**
 * Check if a profile's Chrome data directory appears locked by another Chrome instance.
 * Chrome writes a "SingletonLock" file (Linux/Mac) or "lockfile" (Windows).
 */
export function isProfileLocked(profileDir: string): boolean {
  const lockFiles = ['SingletonLock', 'lockfile', 'SingletonSocket', 'SingletonCookie'];
  for (const lockFile of lockFiles) {
    if (fs.existsSync(path.join(profileDir, lockFile))) {
      return true;
    }
  }
  return false;
}

// ─── Launch Helpers ──────────────────────────────────────────────

/**
 * Returns persistent-context launch args.
 * These reduce automation fingerprints without entering stealth warfare territory.
 */
export function getPersistentLaunchArgs(headed: boolean): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    ...(headed ? ['--start-maximized'] : []),
  ];
}

/**
 * Launch a persistent browser context using a real Chrome profile directory.
 * This is the primary launch path — no disposable contexts.
 *
 * viewport: null lets the browser use its native window size (no fingerprint).
 * channel: 'chrome' prefers the user's installed Chrome Stable.
 */
export async function launchPersistentProfile(
  profileDir: string,
  headed: boolean,
): Promise<BrowserContext> {
  const args = getPersistentLaunchArgs(headed);

  try {
    return await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: !headed,
      viewport: null,
      args,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'dark',
    });
  } catch {
    // Fallback: if Chrome channel is unavailable, use bundled Chromium
    return await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      viewport: null,
      args,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'dark',
    });
  }
}

/**
 * Attach to an already-running Chrome instance via its remote debugging port.
 * The user must have started Chrome with --remote-debugging-port=<port>.
 */
export async function attachToRunningBrowser(wsEndpoint: string): Promise<BrowserContext> {
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('No browser contexts found on the remote Chrome instance.');
  }
  return contexts[0];
}

// ─── Legacy Helpers (kept for capture.ts backward compat) ────────

/**
 * Returns realistic browser launch options (non-persistent path).
 */
export function getRealisticLaunchOptions(headed: boolean): LaunchOptions {
  return {
    headless: !headed,
    args: getPersistentLaunchArgs(headed),
  };
}

/**
 * Launches a non-persistent browser (legacy path for `apigen capture`).
 */
export async function launchRealisticBrowser(headed: boolean) {
  const options = getRealisticLaunchOptions(headed);
  try {
    return await chromium.launch({ ...options, channel: 'chrome' });
  } catch {
    return await chromium.launch(options);
  }
}

/**
 * Returns realistic context options for non-persistent contexts.
 */
export function getRealisticContextOptions(storageState?: any): BrowserContextOptions {
  return {
    storageState,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'dark',
    permissions: ['geolocation', 'notifications'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };
}

/**
 * Injects lightweight javascript patches into the context to remove
 * obvious Playwright fingerprints. NOT needed for persistent Chrome
 * profiles (they use real Chrome identity), but kept for the legacy
 * capture path.
 */
export async function applyRealismToContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format" },
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        }
      ],
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  });
}
