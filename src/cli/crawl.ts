/**
 * CLI command: crawl
 * Persistent-profile BFS crawl with API interception, HITL auth, and session persistence.
 *
 * Architecture: browser trust is identity-based. Authenticated Chrome profiles
 * are the source of trust. HITL establishes identity, automation explores after
 * trust exists.
 *
 * Usage: apigen crawl <url> [--profile <name>] [--profile-dir <path>] [--depth N] [--pages N] [--hitl] [--headed] [--allow-subdomains]
 */

import { Command } from 'commander';
import { BrowserContext, Page } from 'playwright';
import chalk from 'chalk';
import * as readline from 'readline';
import { attachInterceptor, InterceptorController } from '../capture/interceptor';
import { attachWebSocketCapture, getWsSessionCount, getWsFrameCount } from '../capture/websocket';
import { attachSseCapture, getSseStreamCount } from '../capture/sse';
import { getGqlOperationCount } from '../capture/graphql';
import {
  createSession,
  updateSessionCookies,
  saveStorageState,
} from '../db/sessions';
import { getRequestCount } from '../db/requests';
import { detectAuthBoundary, isAuthRoute } from '../capture/auth-detector';
import { logEvent } from '../observability/logger';
import {
  resolveProfileDir,
  isExistingProfile,
  isProfileLocked,
  launchPersistentProfile,
} from '../capture/realism';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min: number, max: number) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

/**
 * Determine if a discovered link is within the allowed crawl scope.
 * By default, only the exact starting hostname is allowed.
 * With --allow-subdomains, subdomains of the starting domain are also permitted.
 */
export function isUrlInScope(linkHostname: string, targetHostname: string, allowSubdomains: boolean): boolean {
  if (linkHostname === targetHostname) return true;
  if (allowSubdomains && linkHostname.endsWith(`.${targetHostname}`)) return true;
  return false;
}

/**
 * Wait for user input (ENTER) via stdin.
 */
function waitForEnter(prompt: string): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

export function registerCrawlCommand(program: Command): void {
  program
    .command('crawl <target-url>')
    .description('Run BFS crawl on target URL with API interception')
    .option('-d, --depth <number>', 'Maximum BFS crawl depth', '3')
    .option('-p, --pages <number>', 'Maximum pages to crawl', '50')
    .option('--profile <name>', 'Persistent Chrome profile name (default: "default")', 'default')
    .option('--profile-dir <path>', 'Custom path for Chrome profile directory')
    .option('--hitl', 'Enable human-in-the-loop auth: pause on auth walls for manual login')
    .option('--headed', 'Run browser in headed (visible) mode')
    .option('--allow-subdomains', 'Allow crawling subdomains of the target domain')
    .option('--save-session <label>', 'Snapshot session on exit')
    .action(async (targetUrl: string, options: any) => {
      const maxDepth = parseInt(options.depth, 10);
      const maxPages = parseInt(options.pages, 10);
      const hitlEnabled: boolean = !!options.hitl;
      const headed: boolean = !!options.headed;
      const allowSubdomains: boolean = !!options.allowSubdomains;
      const profileName: string = options.profileDir || options.profile || 'default';

      console.log(chalk.bold.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('  ║         ApiGen — Crawl Mode          ║'));
      console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝\n'));

      console.log(chalk.yellow(`  Target:    ${targetUrl}`));
      console.log(chalk.gray(`  Max Depth: ${maxDepth}`));
      console.log(chalk.gray(`  Max Pages: ${maxPages}`));

      // Resolve persistent profile
      const profileDir = resolveProfileDir(profileName);
      const isExisting = isExistingProfile(profileDir);

      if (isExisting) {
        console.log(chalk.green(`  Profile:   "${profileName}" (reusing existing)`));
      } else {
        console.log(chalk.cyan(`  Profile:   "${profileName}" (creating new)`));
      }

      if (hitlEnabled) console.log(chalk.magenta(`  HITL:      enabled`));
      if (headed) console.log(chalk.magenta(`  Headed:    enabled`));
      if (allowSubdomains) console.log(chalk.magenta(`  Subdomains: allowed`));
      console.log('');

      // Check for profile lock
      if (isProfileLocked(profileDir)) {
        console.log(chalk.red('  ✗ This Chrome profile appears to be locked by another process.'));
        console.log(chalk.gray('    Close other Chrome instances or use a dedicated ApiGen profile:'));
        console.log(chalk.gray(`    apigen crawl ${targetUrl} --profile apigen-${Date.now()}\n`));
        return;
      }

      let context: BrowserContext | null = null;

      try {
        // Launch persistent Chrome profile
        context = await launchPersistentProfile(profileDir, headed);
        const pages = context.pages();
        const page = pages.length > 0 ? pages[0] : await context.newPage();

        // Create a new DB session for this crawl
        const sessionLabel = options.saveSession || `crawl-${Date.now()}`;
        const sessionId = createSession(sessionLabel);

        // Attach interceptor + WS/SSE capture (returns controller for pause/resume)
        const interceptorCtrl = attachInterceptor(page, { sessionId, quiet: false });
        attachWebSocketCapture(page, { sessionId });
        attachSseCapture(page, { sessionId });

        // Parse target URL
        let parsedTargetUrl: URL;
        try {
          parsedTargetUrl = new URL(targetUrl);
        } catch {
          console.error(chalk.red(`  ✗ Invalid target URL: ${targetUrl}`));
          return;
        }

        const targetHostname = parsedTargetUrl.hostname;

        // BFS Queue
        let queue: { url: string; depth: number }[] = [{ url: targetUrl, depth: 0 }];
        const visited = new Set<string>();
        let pagesProcessed = 0;
        let hitlPauseCount = 0;

        // Auth state tracking
        let isAuthenticated = false;
        const initialCookies = await context.cookies();
        if (initialCookies.some(c => /session|token|auth|jwt/i.test(c.name))) {
          isAuthenticated = true;
          console.log(chalk.green('  ✓ Existing authenticated profile detected.\n'));
        }

        console.log(chalk.blue('  Starting BFS crawl...\n'));

        while (queue.length > 0 && pagesProcessed < maxPages) {
          const current = queue.shift();
          if (!current) break;

          const { url: currentUrl, depth } = current;

          // Normalize URL (strip hash)
          let normalizedUrl = currentUrl;
          try {
            const pureUrl = new URL(currentUrl);
            pureUrl.hash = '';
            normalizedUrl = pureUrl.toString();
          } catch { }

          if (visited.has(normalizedUrl)) continue;

          // Auth route exclusion: skip auth routes post-authentication
          if (isAuthenticated && isAuthRoute(normalizedUrl)) {
            continue;
          }

          visited.add(normalizedUrl);

          console.log(chalk.cyan(`  [Depth ${depth}] Crawling: ${normalizedUrl}`));

          try {
            const navResponse = await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            pagesProcessed++;

            // Auth boundary detection
            const authBoundary = await detectAuthBoundary(page, normalizedUrl, navResponse);

            if (authBoundary) {
              console.log(chalk.red(`\n  ⚠ Auth boundary detected: ${authBoundary.type}`));
              console.log(chalk.gray(`    ${authBoundary.details || ''}`));

              if (hitlEnabled && headed) {
                hitlPauseCount++;

                // Pause interceptor body extraction during manual auth
                interceptorCtrl.pause();
                logEvent('interceptor.paused', { reason: 'hitl_auth', url: normalizedUrl });

                console.log(chalk.bold.yellow(
                  '\n  🔐 Authentication required. Complete login in the browser window.'
                ));
                console.log(chalk.gray('     The crawl is frozen. Only network logging remains active.\n'));

                // Freeze crawl and wait for manual completion
                await waitForEnter('  Press ENTER when ready to resume crawl... ');

                logEvent('hitl.auth_resumed', { url: normalizedUrl, pause_count: hitlPauseCount });
                console.log(chalk.green('  ✓ Resuming crawl with authenticated context.\n'));
                console.log(chalk.gray('  Waiting for session state to stabilize...'));

                // Stabilization delay — allow redirects and cookies to settle
                await randomDelay(5000, 10000);

                // Resume interceptor body extraction
                interceptorCtrl.resume();
                logEvent('interceptor.resumed', { url: normalizedUrl });

                // Authentication Success Validation
                const currentPageUrl = page.url();
                const cookies = await context.cookies();
                const hasAuthCookies = cookies.some(c => /session|token|auth|jwt/i.test(c.name));
                const navigatedAway = currentPageUrl !== normalizedUrl && !isAuthRoute(currentPageUrl);

                if (hasAuthCookies || navigatedAway) {
                  isAuthenticated = true;
                  console.log(chalk.green('  ✓ Authentication verified. Transitioning to authenticated exploration.\n'));

                  // Persist session state IMMEDIATELY after successful auth (don't wait for crawl end)
                  try {
                    const storageState = await context.storageState();
                    saveStorageState(sessionId, storageState);
                    const authCookies = await context.cookies();
                    updateSessionCookies(sessionId, authCookies);
                    logEvent('session.persisted_after_auth', { session_id: sessionId });
                    console.log(chalk.gray(`  Session state saved immediately.`));
                  } catch {
                    console.log(chalk.yellow(`  ⚠ Could not persist session state after auth.`));
                  }

                  // Queue sanitization: purge auth routes
                  const originalLength = queue.length;
                  queue = queue.filter(item => !isAuthRoute(item.url));
                  const removed = originalLength - queue.length;
                  if (removed > 0) {
                    console.log(chalk.gray(`  Purged ${removed} auth-related URLs from the queue.`));
                  }

                  // Authenticated warmup: brief pause before aggressive BFS resumes
                  console.log(chalk.gray('  Warming up authenticated session...\n'));
                  await randomDelay(2000, 4000);
                } else {
                  console.log(chalk.red('  ✗ Authentication validation failed. Remaining in HITL mode.\n'));
                  // Stay unauthenticated — next auth boundary will re-trigger HITL
                }

              } else if (hitlEnabled && !headed) {
                console.log(chalk.yellow('  ⚠ HITL requires --headed flag. Skipping auth wall.'));
                logEvent('hitl.skipped_headless', { url: normalizedUrl });
              } else {
                console.log(chalk.yellow('  Skipping (use --hitl --headed to handle auth walls)'));
              }

              // Never perform autonomous interactions on auth/captcha pages
              continue;
            }

            // Random delay to avoid detection on normal pages
            await randomDelay(500, 1500);

            // Discover links at this depth (ONLY for non-auth pages)
            if (depth < maxDepth) {
              const links = await page.$$eval('a', anchors =>
                anchors.map(a => (a as HTMLAnchorElement).href)
              );

              for (const link of links) {
                if (!link) continue;
                try {
                  const parsedLink = new URL(link);

                  // Domain gating: strict scope enforcement
                  if (!isUrlInScope(parsedLink.hostname, targetHostname, allowSubdomains)) {
                    continue;
                  }

                  parsedLink.hash = '';
                  const nextUrl = parsedLink.toString();

                  // Auth route exclusion: NEVER queue auth routes post-authentication
                  if (isAuthenticated && isAuthRoute(nextUrl)) {
                    continue;
                  }

                  if (!visited.has(nextUrl)) {
                    queue.push({ url: nextUrl, depth: depth + 1 });
                  }
                } catch { }
              }
            }
          } catch (navError: any) {
            console.log(chalk.red(`  ✗ Failed: ${normalizedUrl} — ${navError.message}`));
          }
        }

        // Persist session state at crawl completion
        try {
          const storageState = await context.storageState();
          saveStorageState(sessionId, storageState);
          const cookies = await context.cookies();
          updateSessionCookies(sessionId, cookies);
          console.log(chalk.green(`\n  ✓ Session state persisted as "${sessionLabel}"`));
        } catch {
          console.log(chalk.yellow(`\n  ⚠ Could not persist session state`));
        }

        // Stats
        const requestCount = getRequestCount();
        const wsCount = getWsSessionCount();
        const wsFrames = getWsFrameCount();
        const gqlCount = getGqlOperationCount();
        const sseCount = getSseStreamCount();
        console.log(chalk.bold.green(`\n  ✓ Crawl complete!`));
        console.log(chalk.gray(`    Pages processed:   ${pagesProcessed}`));
        console.log(chalk.gray(`    HTTP requests:     ${requestCount}`));
        if (wsCount > 0) console.log(chalk.gray(`    WS sessions:       ${wsCount} (${wsFrames} frames)`));
        if (gqlCount > 0) console.log(chalk.gray(`    GraphQL ops:       ${gqlCount}`));
        if (sseCount > 0) console.log(chalk.gray(`    SSE streams:       ${sseCount}`));
        if (hitlPauseCount > 0) console.log(chalk.gray(`    Auth pauses:       ${hitlPauseCount}`));
        console.log(chalk.gray(`    Profile:           ${profileDir}`));
        console.log(chalk.gray(`    Database:          .apigen/db.sqlite\n`));

      } catch (error) {
        console.error(chalk.red('  ✗ Crawler failed:'), error);
      } finally {
        if (context) await context.close();
      }
    });
}
