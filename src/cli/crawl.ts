/**
 * CLI command: crawl
 * L1+L4: Headless BFS crawl with API interception
 * 
 * Usage: apigen crawl <url> [--depth N] [--pages N] [--session <label>]
 */

import { Command } from 'commander';
import { chromium, Browser } from 'playwright';
import chalk from 'chalk';
import { attachInterceptor } from '../capture/interceptor';
import { attachWebSocketCapture, getWsSessionCount, getWsFrameCount } from '../capture/websocket';
import { attachSseCapture, getSseStreamCount } from '../capture/sse';
import { getGqlOperationCount } from '../capture/graphql';
import { createSession, getSessionByLabel, updateSessionCookies } from '../db/sessions';
import { getRequestCount } from '../db/requests';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min: number, max: number) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

export function registerCrawlCommand(program: Command): void {
  program
    .command('crawl <target-url>')
    .description('Run headless BFS crawl on target URL with API interception')
    .option('-d, --depth <number>', 'Maximum BFS crawl depth', '3')
    .option('-p, --pages <number>', 'Maximum pages to crawl', '50')
    .option('--session <label>', 'Restore a saved session (cookies)')
    .option('--save-session <label>', 'Snapshot session on exit')
    .action(async (targetUrl: string, options: any) => {
      const maxDepth = parseInt(options.depth, 10);
      const maxPages = parseInt(options.pages, 10);

      console.log(chalk.bold.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('  ║         ApiGen — Crawl Mode          ║'));
      console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝\n'));

      console.log(chalk.yellow(`  Target:    ${targetUrl}`));
      console.log(chalk.gray(`  Max Depth: ${maxDepth}`));
      console.log(chalk.gray(`  Max Pages: ${maxPages}\n`));

      let browser: Browser | null = null;

      try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext();

        // Restore session if specified
        if (options.session) {
          const existingSession = getSessionByLabel(options.session);
          if (existingSession?.cookies) {
            try {
              const cookies = JSON.parse(existingSession.cookies);
              await context.addCookies(cookies);
              console.log(chalk.green(`  ✓ Restored session "${options.session}"\n`));
            } catch {
              console.log(chalk.red(`  ✗ Failed to restore session "${options.session}"\n`));
            }
          } else {
            console.log(chalk.yellow(`  ⚠ No session found with label "${options.session}"\n`));
          }
        }

        const page = await context.newPage();

        // Create a new session for this crawl
        const sessionId = createSession(options.saveSession || `crawl-${Date.now()}`);

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

        const domain = parsedTargetUrl.hostname;

        // BFS Queue
        const queue: { url: string; depth: number }[] = [{ url: targetUrl, depth: 0 }];
        const visited = new Set<string>();
        let pagesProcessed = 0;

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
            await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            pagesProcessed++;

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
                  if (parsedLink.hostname === domain || parsedLink.hostname.endsWith(`.${domain}`)) {
                    parsedLink.hash = '';
                    const nextUrl = parsedLink.toString();
                    if (!visited.has(nextUrl)) {
                      queue.push({ url: nextUrl, depth: depth + 1 });
                    }
                  }
                } catch {}
              }
            }
          } catch (navError: any) {
            console.log(chalk.red(`  ✗ Failed: ${normalizedUrl} — ${navError.message}`));
          }
        }

        // Save session cookies if requested
        if (options.saveSession) {
          const cookies = await context.cookies();
          updateSessionCookies(sessionId, cookies);
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
        console.log(chalk.gray(`    Database: .apigen/db.sqlite\n`));

      } catch (error) {
        console.error(chalk.red('  ✗ Crawler failed:'), error);
      } finally {
        if (browser) await browser.close();
      }
    });
}
