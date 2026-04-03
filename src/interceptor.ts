import { Page, Request, Response } from 'playwright';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import { insertEndpoint, EndpointData } from './db';

const TARGET_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

export function attachInterceptor(page: Page) {
  page.on('response', async (response: Response) => {
    const request = response.request();
    const resourceType = request.resourceType();

    if (!TARGET_RESOURCE_TYPES.has(resourceType)) {
      return;
    }

    const url = request.url();

    if (
      url.includes('google-analytics.com') ||
      url.includes('googletagmanager.com') ||
      url.match(/\.(png|jpg|jpeg|gif|css|woff2?|js|ico|svg)$/i)
    ) {
      return;
    }

    const method = request.method();

    if (method === 'OPTIONS') return;

    try {
      const status = response.status();
      const headers = request.headers();

      let reqBodyParsed: any = null;
      let resBodyParsed: any = null;

      const postData = request.postData();
      if (postData) {
        try {
          reqBodyParsed = JSON.parse(postData);
        } catch {
          reqBodyParsed = postData;
        }
      }

      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('application/json') || contentType.includes('text/')) {
        try {
          const resBodyBuffer = await response.body();
          const resBodyString = resBodyBuffer.toString('utf-8');
          try {
            resBodyParsed = JSON.parse(resBodyString);
          } catch {
            resBodyParsed = resBodyString;
          }
        } catch (err) {
          resBodyParsed = null;
        }
      } else {
        resBodyParsed = "[Binary or Unsupported Content]";
      }

      let finalUrl = url;
      if (reqBodyParsed && reqBodyParsed.operationName && finalUrl.includes('/graphql')) {
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl = `${finalUrl}${separator}op=${reqBodyParsed.operationName}`;
      }

      let pathPattern = '/';
      try {
        pathPattern = new URL(finalUrl).pathname;
      } catch { }

      const data: EndpointData = {
        id: randomUUID(),
        method,
        url: finalUrl,
        path_pattern: pathPattern,
        request_headers: headers,
        request_body: reqBodyParsed,
        response_status: status,
        response_body: resBodyParsed
      };

      insertEndpoint(data);

      const color = status >= 400 ? chalk.red : chalk.green;
      console.log(`${chalk.cyan(`[${method}]`)} ${color(status)} - ${url}`);
    } catch (err) {
      console.error(chalk.red('[Interceptor Error]'), err);
    }
  });
}
