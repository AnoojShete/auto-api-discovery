#!/usr/bin/env node
import { Command } from 'commander';
import { chromium } from 'playwright';
import chalk from 'chalk';
import { attachInterceptor } from './interceptor';
import * as fs from 'fs';
import { getAllEndpoints } from './db';
import { generateSchemaMap } from './schema-engine';
import { generateOpenAPI } from './openapi-generator';
import { startCrawler } from './crawler';
import * as path from 'path';

const program = new Command();

program
  .name('apigen')
  .description('API discovery automation CLI')
  .version('1.0.0');

program
  .command('capture <url>')
  .description('Launch Playwright to capture API traffic')
  .action(async (url: string) => {
    console.log(chalk.yellow(`Starting capture engine...`));
    console.log(chalk.blue(`Navigating to: ${url}`));

    try {
      const browser = await chromium.launch({ headless: false });
      const context = await browser.newContext();
      const page = await context.newPage();

      attachInterceptor(page);

      await page.goto(url, { waitUntil: 'domcontentloaded' });

      console.log(chalk.green('Navigation complete. Intercepting API traffic...'));
      console.log(chalk.gray('Terminal output shows real-time capture. Close the browser window to exit.'));

      const sessionFile = path.resolve(process.cwd(), '.apigen-session.json');
      let isRunning = true;

      browser.on('disconnected', () => {
        isRunning = false;
        console.log(chalk.yellow('\nBrowser closed. Session saved. Exiting apigen gracefully...'));
        process.exit(0);
      });

      while (isRunning) {
        try {
          const cookies = await context.cookies();
          fs.writeFileSync(sessionFile, JSON.stringify(cookies, null, 2), 'utf-8');
        } catch (e) {
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch (error) {
      console.error(chalk.red('Failed to start capture:'), error);
      process.exit(1);
    }
  });

program
  .command('export <output-file-json>')
  .description('Export OpenAPI 3.0 specification from intercepted database traffic')
  .option('-b, --base-url <url>', 'Base URL for OpenAPI specification', 'http://localhost')
  .action((outputFile: string, options: any) => {
    console.log(chalk.yellow('Reading endpoints from database...'));
    const endpoints = getAllEndpoints();

    if (endpoints.length === 0) {
      console.log(chalk.red('No endpoints found in database to export.'));
      process.exit(0);
    }

    console.log(chalk.blue(`Found ${endpoints.length} raw endpoints. Generating schema map...`));

    const schemaMap = generateSchemaMap(endpoints);
    const finalMap = Object.values(schemaMap);

    console.log(chalk.green(`Folded into ${finalMap.length} unique routes.`));
    console.log(chalk.blue('Converting to OpenAPI 3.0 specification...'));

    const openapiSpec = generateOpenAPI(finalMap, options.baseUrl);

    fs.writeFileSync(outputFile, JSON.stringify(openapiSpec, null, 2), 'utf-8');
    console.log(chalk.green(`Export complete: ${outputFile}`));
  });

program
  .command('crawl <target-url>')
  .description('Run authenticated headless crawler on target URL')
  .option('-d, --depth <number>', 'Maximum BFS crawl depth', '2')
  .option('-p, --pages <number>', 'Maximum pages to crawl', '50')
  .action(async (targetUrl: string, options: any) => {
    const maxDepth = parseInt(options.depth, 10);
    const maxPages = parseInt(options.pages, 10);
    await startCrawler(targetUrl, maxDepth, maxPages);
  });

program.parse(process.argv);
