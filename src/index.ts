#!/usr/bin/env node
/**
 * ApiGen — API Discovery Automation CLI
 * 
 * A hybrid API discovery system that intercepts, infers, and reconstructs
 * OpenAPI 3.0 specifications from arbitrary web applications.
 * 
 * Commands:
 *   capture <url>       Interactive capture with browser
 *   crawl <url>         Headless BFS crawl with interception
 *   export <outfile>    Export OpenAPI 3.0 specification
 *   stats              Show database summary
 *   sessions list      List saved sessions
 *   sessions delete    Delete a saved session
 *   reset              Wipe .apigen/ directory
 */

import { Command } from 'commander';
import { registerCaptureCommand } from './cli/capture';
import { registerCrawlCommand } from './cli/crawl';
import { registerExportCommand } from './cli/export';
import { registerStatsCommand } from './cli/stats';
import { registerSessionsCommand } from './cli/sessions';
import { registerResetCommand } from './cli/reset';

const program = new Command();

program
  .name('apigen')
  .description('API discovery automation — intercept, infer, and reconstruct OpenAPI specs')
  .version('2.0.0');

// Register all commands
registerCaptureCommand(program);
registerCrawlCommand(program);
registerExportCommand(program);
registerStatsCommand(program);
registerSessionsCommand(program);
registerResetCommand(program);

program.parse(process.argv);
