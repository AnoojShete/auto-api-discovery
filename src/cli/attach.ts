/**
 * CLI command: attach
 * Connect ApiGen interception to an already-running Chrome instance
 * via Chrome DevTools Protocol (CDP).
 *
 * Prerequisites:
 *   Launch Chrome with: chrome --remote-debugging-port=9222
 *
 * Usage: apigen attach [--port <number>] [--save-session <label>]
 */

import { Command } from 'commander';
import { BrowserContext } from 'playwright';
import chalk from 'chalk';
import { attachInterceptor } from '../capture/interceptor';
import { attachWebSocketCapture, getWsSessionCount, getWsFrameCount } from '../capture/websocket';
import { attachSseCapture, getSseStreamCount } from '../capture/sse';
import { getGqlOperationCount } from '../capture/graphql';
import { createSession, updateSessionCookies, saveStorageState } from '../db/sessions';
import { getRequestCount } from '../db/requests';
import { attachToRunningBrowser } from '../capture/realism';

export function registerAttachCommand(program: Command): void {
  program
    .command('attach')
    .description('Attach ApiGen interception to an already-running Chrome instance')
    .option('--port <number>', 'Chrome remote debugging port', '9222')
    .option('--ws <endpoint>', 'WebSocket endpoint URL (overrides --port)')
    .option('--save-session <label>', 'Snapshot session on exit')
    .action(async (options: any) => {
      const port = parseInt(options.port, 10);
      const wsEndpoint = options.ws || `http://localhost:${port}`;

      console.log(chalk.bold.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('  ║        ApiGen — Attach Mode          ║'));
      console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝\n'));

      console.log(chalk.yellow(`  Connecting to: ${wsEndpoint}`));
      console.log(chalk.gray('  Ensure Chrome was launched with:'));
      console.log(chalk.gray(`    chrome --remote-debugging-port=${port}\n`));

      let context: BrowserContext | null = null;

      try {
        context = await attachToRunningBrowser(wsEndpoint);
        const pages = context.pages();

        if (pages.length === 0) {
          console.log(chalk.red('  ✗ No pages found in the remote browser.'));
          return;
        }

        console.log(chalk.green(`  ✓ Attached to Chrome (${pages.length} page(s) found)\n`));

        // Create session
        const sessionLabel = options.saveSession || `attach-${Date.now()}`;
        const sessionId = createSession(sessionLabel);

        // Attach interceptors to ALL existing pages
        for (const page of pages) {
          attachInterceptor(page, { sessionId, quiet: false });
          attachWebSocketCapture(page, { sessionId });
          attachSseCapture(page, { sessionId });
        }

        // Also attach interceptors to any NEW pages opened
        context.on('page', (page) => {
          console.log(chalk.cyan(`  [Attach] New page detected: ${page.url()}`));
          attachInterceptor(page, { sessionId, quiet: false });
          attachWebSocketCapture(page, { sessionId });
          attachSseCapture(page, { sessionId });
        });

        console.log(chalk.green('  ✓ Interception active. Browse normally in Chrome.\n'));
        console.log(chalk.gray('  Press Ctrl+C to stop and save session.\n'));

        // Keep alive until user kills process
        const shutdown = async () => {
          // Persist session state
          try {
            const storageState = await context!.storageState();
            saveStorageState(sessionId, storageState);
            const cookies = await context!.cookies();
            updateSessionCookies(sessionId, cookies);
          } catch { }

          // Stats
          const requestCount = getRequestCount();
          const wsCount = getWsSessionCount();
          const wsFrames = getWsFrameCount();
          const gqlCount = getGqlOperationCount();
          const sseCount = getSseStreamCount();
          console.log(chalk.bold.green(`\n  ✓ Attach session complete!`));
          console.log(chalk.gray(`    HTTP requests:     ${requestCount}`));
          if (wsCount > 0) console.log(chalk.gray(`    WS sessions:       ${wsCount} (${wsFrames} frames)`));
          if (gqlCount > 0) console.log(chalk.gray(`    GraphQL ops:       ${gqlCount}`));
          if (sseCount > 0) console.log(chalk.gray(`    SSE streams:       ${sseCount}`));
          console.log(chalk.gray(`    Database:          .apigen/db.sqlite\n`));
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Wait indefinitely
        await new Promise(() => { });

      } catch (error: any) {
        if (error.message?.includes('ECONNREFUSED')) {
          console.log(chalk.red('  ✗ Connection refused. Is Chrome running with remote debugging?'));
          console.log(chalk.gray(`    Launch Chrome with: chrome --remote-debugging-port=${port}\n`));
        } else {
          console.error(chalk.red('  ✗ Attach failed:'), error.message || error);
        }
      }
    });
}
