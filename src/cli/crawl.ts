/**
 * CLI command: crawl
 * Headless BFS crawl with API interception, domain gating, HITL auth, and session persistence.
 * 
 * Usage: apigen crawl <url> [--depth N] [--pages N] [--session <label>] [--hitl] [--headed] [--allow-subdomains]
 */

import { Command } from 'commander';
import { chromium, Browser, BrowserContext, Page, Response as PwResponse } from 'playwright';
import chalk from 'chalk';
import * as readline from 'readline';
import { attachInterceptor } from '../capture/interceptor';
import { attachWebSocketCapture, getWsSessionCount, getWsFrameCount } from '../capture/websocket';
import { attachSseCapture, getSseStreamCount } from '../capture/sse';
import { getGqlOperationCount } from '../capture/graphql';
import {
  createSession,
  getSessionByLabel,
  updateSessionCookies,
  saveStorageState,
  loadStorageState,
  isSessionLikelyValid,
} from '../db/sessions';
import { getRequestCount } from '../db/requests';
import { detectAuthBoundary, AuthBoundaryEvent } from '../capture/auth-detector';
import { logEvent } from '../observability/logger';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min: number, max: number) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

/**
 * Determine if a discovered link is within the allowed crawl scope.
 * By default, only the exact starting hostname is allowed.
 * With --allow-subdomains, subdomains of the starting domain are also permitted.
 */
export function isUrlInScope(linkHostname: string, targetHostname: string, allowSubdomains: boolean): boolean {
  // Exact match always allowed
  if (linkHostname === targetHostname) return true;

  // Subdomain match only if flag is set
  if (allowSubdomains && linkHostname.endsWith(`.${targetHostname}`)) {
    return true;
  }

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
    .option('--session <label>', 'Restore a saved session (cookies + storageState)')
    .option('--save-session <label>', 'Snapshot session on exit')
    .option('--hitl', 'Enable human-in-the-loop auth: pause on auth walls for manual login')
    .option('--headed', 'Run browser in headed (visible) mode')
    .option('--allow-subdomains', 'Allow crawling subdomains of the target domain')
    .action(async (targetUrl: string, options: any) => {
      const maxDepth = parseInt(options.depth, 10);
      const maxPages = parseInt(options.pages, 10);
      const hitlEnabled: boolean = !!options.hitl;
      const headed: boolean = !!options.headed;
      const allowSubdomains: boolean = !!options.allowSubdomains;

      console.log(chalk.bold.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('  ║         ApiGen — Crawl Mode          ║'));
      console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝\n'));

      console.log(chalk.yellow(`  Target:    ${targetUrl}`));
      console.log(chalk.gray(`  Max Depth: ${maxDepth}`));
      console.log(chalk.gray(`  Max Pages: ${maxPages}`));
      if (hitlEnabled) console.log(chalk.magenta(`  HITL:      enabled`));
      if (headed) console.log(chalk.magenta(`  Headed:    enabled`));
      if (allowSubdomains) console.log(chalk.magenta(`  Subdomains: allowed`));
      console.log('');

      let browser: Browser | null = null;

      try {
        browser = await chromium.launch({ headless: !headed });

        // Restore full storageState if available, otherwise fall back to cookies
        let context: BrowserContext;
        let sessionRestored = false;

        if (options.session) {
          // Check session validity before restoring
          if (isSessionLikelyValid(options.session)) {
            const storageState = loadStorageState(options.session);
            if (storageState) {
              context = await browser.newContext({ storageState });
              sessionRestored = true;
              console.log(chalk.green(`  ✓ Restored full session "${options.session}" (storageState)\n`));
            } else {
              // Fall back to cookie-only restore
              const existingSession = getSessionByLabel(options.session);
              if (existingSession?.cookies) {
                context = await browser.newContext();
                try {
                  const cookies = JSON.parse(existingSession.cookies);
                  await context.addCookies(cookies);
                  sessionRestored = true;
                  console.log(chalk.green(`  ✓ Restored session "${options.session}" (cookies only)\n`));
                } catch {
                  console.log(chalk.red(`  ✗ Failed to parse session cookies "${options.session}"\n`));
                  context = await browser.newContext();
                }
              } else {
                console.log(chalk.yellow(`  ⚠ No session data found for "${options.session}"\n`));
                context = await browser.newContext();
              }
            }
          } else {
            console.log(chalk.yellow(`  ⚠ Session "${options.session}" is expired or missing. Starting fresh.\n`));
            context = await browser.newContext();
          }
        } else {
          context = await browser.newContext();
        }

        const page = await context.newPage();

        // Create a new session for this crawl
        const sessionLabel = options.saveSession || `crawl-${Date.now()}`;
        const sessionId = createSession(sessionLabel);

        // Attach interceptor + WS/SSE capture
        attachInterceptor(page, { sessionId, quiet: false });
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
        const queue: { url: string; depth: number }[] = [{ url: targetUrl, depth: 0 }];
        const visited = new Set<string>();
        let pagesProcessed = 0;
        let hitlPauseCount = 0;

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
          } catch {}

          if (visited.has(normalizedUrl)) continue;
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
                console.log(chalk.bold.yellow(
                  '\n  🔐 Authentication required. Complete login in the browser window.'
                ));
                console.log(chalk.gray('     The crawl will resume in the same browser context.\n'));

                await waitForEnter('  Press ENTER when ready to resume crawl... ');

                // After user resumes, save the updated session state
                logEvent('hitl.auth_resumed', { url: normalizedUrl, pause_count: hitlPauseCount });
                console.log(chalk.green('  ✓ Resuming crawl with authenticated context.\n'));

                // Re-navigate to the page we were trying to crawl
                try {
                  await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                } catch {}
              } else if (hitlEnabled && !headed) {
                console.log(chalk.yellow('  ⚠ HITL requires --headed flag. Skipping auth wall.'));
                logEvent('hitl.skipped_headless', { url: normalizedUrl });
              } else {
                console.log(chalk.yellow('  Skipping (use --hitl --headed to handle auth walls)'));
              }
            }

            // Random delay to avoid detection
            await randomDelay(500, 1500);

            // Discover links at this depth
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
                  if (!visited.has(nextUrl)) {
                    queue.push({ url: nextUrl, depth: depth + 1 });
                  }
                } catch {}
              }
            }
          } catch (navError: any) {
            console.log(chalk.red(`  ✗ Failed: ${normalizedUrl} — ${navError.message}`));
          }
        }

        // Persist session state
        if (options.saveSession || options.session) {
          try {
            const storageState = await context.storageState();
            saveStorageState(sessionId, storageState);
            const cookies = await context.cookies();
            updateSessionCookies(sessionId, cookies);
            console.log(chalk.green(`\n  ✓ Session state persisted as "${sessionLabel}"`));
          } catch (err) {
            console.log(chalk.yellow(`\n  ⚠ Could not persist session state`));
          }
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
        if (wsCount > 0)  console.log(chalk.gray(`    WS sessions:       ${wsCount} (${wsFrames} frames)`));
        if (gqlCount > 0) console.log(chalk.gray(`    GraphQL ops:       ${gqlCount}`));
        if (sseCount > 0) console.log(chalk.gray(`    SSE streams:       ${sseCount}`));
        if (hitlPauseCount > 0) console.log(chalk.gray(`    Auth pauses:       ${hitlPauseCount}`));
        console.log(chalk.gray(`    Database: .apigen/db.sqlite\n`));

      } catch (error) {
        console.error(chalk.red('  ✗ Crawler failed:'), error);
      } finally {
        if (browser) await browser.close();
      }
    });
}
