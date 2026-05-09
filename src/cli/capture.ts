/**
 * CLI command: capture
 * L1: Interactive capture with browser
 * 
 * Usage: apigen capture <url> [--save-session <label>]
 */

import { Command } from 'commander';
import { chromium } from 'playwright';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { attachInterceptor } from '../capture/interceptor';
import { attachWebSocketCapture } from '../capture/websocket';
import { attachSseCapture } from '../capture/sse';
import { createSession, updateSessionCookies } from '../db/sessions';
import { getRequestCount } from '../db/requests';
import { getWsSessionCount, getWsFrameCount } from '../capture/websocket';
import { getGqlOperationCount } from '../capture/graphql';
import { getSseStreamCount } from '../capture/sse';

export function registerCaptureCommand(program: Command): void {
  program
    .command('capture <url>')
    .description('Launch Playwright to capture API traffic interactively')
    .option('--save-session <label>', 'Snapshot session on exit with this label')
    .action(async (url: string, options: { saveSession?: string }) => {
      console.log(chalk.bold.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('  ║        ApiGen — Capture Mode         ║'));
      console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝\n'));

      console.log(chalk.yellow(`  Target: ${url}`));
      console.log(chalk.gray('  Close the browser window to stop capture.\n'));

      try {
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        const page = await context.newPage();

        // Create session in database
        const sessionId = createSession(options.saveSession || 'capture');

        // Attach the refactored interceptor
        attachInterceptor(page, {
          sessionId,
          onCapture: (info) => {
            // Real-time stats could be emitted here
          },
        });

        // Attach WebSocket capture
        attachWebSocketCapture(page, { sessionId });

        // Attach SSE capture
        attachSseCapture(page, { sessionId });

        // Navigate
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        console.log(chalk.green('  ✓ Navigation complete. Intercepting API traffic...\n'));

        let isRunning = true;

        browser.on('disconnected', async () => {
          isRunning = false;

          // Show final stats
          const count = getRequestCount();
          const wsCount = getWsSessionCount();
          const wsFrames = getWsFrameCount();
          const gqlCount = getGqlOperationCount();
          const sseCount = getSseStreamCount();
          console.log(chalk.bold.green(`\n  ✓ Capture complete!`));
          console.log(chalk.gray(`    HTTP requests:    ${count}`));
          if (wsCount > 0)  console.log(chalk.gray(`    WS sessions:      ${wsCount} (${wsFrames} frames)`));
          if (gqlCount > 0) console.log(chalk.gray(`    GraphQL ops:      ${gqlCount}`));
          if (sseCount > 0) console.log(chalk.gray(`    SSE streams:      ${sseCount}`));

          if (options.saveSession) {
            console.log(chalk.gray(`    Session saved as: "${options.saveSession}"`));
          }

          console.log(chalk.gray('    Database: .apigen/db.sqlite\n'));
          process.exit(0);
        });

        // Periodically save cookies
        while (isRunning) {
          try {
            const cookies = await context.cookies();
            updateSessionCookies(sessionId, cookies);
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

      } catch (error) {
        console.error(chalk.red('\n  ✗ Failed to start capture:'), error);
        process.exit(1);
      }
    });
}
