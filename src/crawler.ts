import { chromium, Browser, Page } from 'playwright';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { attachInterceptor } from './interceptor';

const SESSION_FILE = path.resolve(process.cwd(), '.apigen-session.json');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min: number, max: number) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

export async function startCrawler(targetUrl: string, maxDepth: number = 2, maxPages: number = 50) {
  console.log(chalk.yellow(`Starting crawler for ${targetUrl} (Max Depth: ${maxDepth}, Max Pages: ${maxPages})...`));

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    if (fs.existsSync(SESSION_FILE)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        await context.addCookies(cookies);
        console.log(chalk.green('Loaded session cookies successfully. Crawler is authenticated.'));
      } catch (err) {
        console.error(chalk.red('Failed to load cookies from session file.'), err);
      }
    }

    const page = await context.newPage();
    attachInterceptor(page);

    let parsedTargetUrl: URL;
    try {
      parsedTargetUrl = new URL(targetUrl);
    } catch {
      console.error(chalk.red(`Invalid target URL: ${targetUrl}`));
      return;
    }

    const domain = parsedTargetUrl.hostname;

    // BFS Queue: { url, currentDepth }
    const queue: { url: string; depth: number }[] = [{ url: targetUrl, depth: 0 }];
    const visited = new Set<string>();
    let pagesProcessed = 0;

    console.log(chalk.blue('Beginning Breadth-First Spidering algorithm...'));

    while (queue.length > 0 && pagesProcessed < maxPages) {
      const current = queue.shift();
      if (!current) break;

      const { url: currentUrl, depth } = current;

      let normalizedUrl = currentUrl;
      try {
        const pureUrl = new URL(currentUrl);
        pureUrl.hash = '';
        normalizedUrl = pureUrl.toString();
      } catch { }

      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      console.log(chalk.cyan(`[Depth ${depth}] Crawling: ${normalizedUrl}`));

      try {
        await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        pagesProcessed++;

        await randomDelay(500, 1500);

        if (depth < maxDepth) {
          const links = await page.$$eval('a', anchors => anchors.map(a => (a as HTMLAnchorElement).href));

          for (const link of links) {
            if (!link) continue;

            try {
              const parsedLink = new URL(link);
              if (parsedLink.hostname === domain || parsedLink.hostname.endsWith(`.${domain}`)) {
                parsedLink.hash = '';
                const nextUrl = parsedLink.toString();
                if (!visited.has(nextUrl)) {
                  visited.add(nextUrl);
                  queue.push({ url: nextUrl, depth: depth + 1 });
                }
              }
            } catch (err) {
            }
          }
        }
      } catch (navError: any) {
        console.log(chalk.red(`Failed to crawl ${normalizedUrl} - `) + navError.message);
      }
    }

    console.log(chalk.green(`Crawl completed! Processed ${pagesProcessed} pages and intercepted traffic.`));
  } catch (error) {
    console.error(chalk.red('Crawler failed:'), error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
