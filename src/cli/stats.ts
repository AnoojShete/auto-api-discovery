/**
 * CLI command: stats
 * Usage: apigen stats
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { getDb } from '../db/schema';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show summary of discovery database contents')
    .action(() => {
      console.log(chalk.bold.cyan('\n  ApiGen — Database Stats\n'));
      try {
        const db = getDb();
        const count = (t: string) => {
          try { return (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as any)?.c ?? 0; }
          catch { return 0; }
        };
        console.log(`  Requests:        ${chalk.green(count('requests'))}`);
        console.log(`  Endpoints:       ${chalk.green(count('endpoints'))}`);
        console.log(`  Schemas:         ${chalk.green(count('schemas'))}`);
        console.log(`  Sessions:        ${chalk.green(count('sessions'))}`);
        console.log(`  GraphQL Ops:     ${chalk.green(count('gql_operations'))}`);
        console.log(`  WS Sessions:     ${chalk.green(count('ws_sessions'))}`);
        console.log(`  WS Frames:       ${chalk.green(count('ws_frames'))}`);
        console.log(`  SSE Streams:     ${chalk.green(count('sse_streams'))}`);
        console.log(`  SSE Events:      ${chalk.green(count('sse_events'))}`);
        console.log(`  Bundle Findings: ${chalk.green(count('bundle_findings'))}`);
        console.log(`  Corrections:     ${chalk.green(count('corrections'))}`);

        const topEndpoints = db.prepare(
          `SELECT method, path_template, observation_count FROM endpoints ORDER BY observation_count DESC LIMIT 10`
        ).all() as any[];
        if (topEndpoints.length > 0) {
          console.log(chalk.white('\n  Top Endpoints:'));
          for (const ep of topEndpoints) {
            console.log(`  ${chalk.cyan(ep.method.padEnd(8))} ${ep.path_template} ${chalk.gray(`(${ep.observation_count}x)`)}`);
          }
        }
        console.log('');
      } catch { console.log(chalk.red('  No database found. Run capture/crawl first.\n')); }
    });
}
