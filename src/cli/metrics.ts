/**
 * CLI command: metrics
 * Usage: apigen metrics
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getDb } from '../db/schema';
import { getTelemetryDropCount } from '../db/telemetry';
import { getParseDiagnosticCount, getReplaySuccessRate } from '../db/diagnostics';

export function registerMetricsCommand(program: Command): void {
  program
    .command('metrics')
    .description('Show capture quality and filtering metrics')
    .option('--json', 'Output JSON metrics')
    .option('--table', 'Output human-readable table')
    .action((options: { json?: boolean; table?: boolean }) => {
      try {
        const db = getDb();

        const rawRequests = (db.prepare('SELECT COUNT(*) as c FROM requests').get() as any)?.c ?? 0;
        const endpoints = (db.prepare('SELECT COUNT(*) as c FROM endpoints').get() as any)?.c ?? 0;
        const lowConfidence = (db.prepare('SELECT COUNT(*) as c FROM endpoints WHERE observation_count < 3').get() as any)?.c ?? 0;
        const gqlOps = (db.prepare('SELECT COUNT(*) as c FROM gql_operations').get() as any)?.c ?? 0;

        const telemetryDrops = getTelemetryDropCount();
        const parseFailures = getParseDiagnosticCount();
        const replay = getReplaySuccessRate();

        const schemaConfidence = endpoints > 0
          ? Math.round(((endpoints - lowConfidence) / endpoints) * 1000) / 10
          : null;

        const replaySuccessRate = replay.total > 0
          ? Math.round((replay.success / replay.total) * 1000) / 10
          : null;

        const metrics = {
          raw_requests: rawRequests,
          deduplicated_endpoints: endpoints,
          schema_confidence_percent: schemaConfidence,
          failed_body_parses: parseFailures,
          filtered_telemetry_count: telemetryDrops,
          graphql_operations: gqlOps,
          replay_success_rate_percent: replaySuccessRate,
        };

        const wantJson = options.json || (!options.json && !options.table);
        const wantTable = options.table || (!options.json && !options.table);

        if (wantTable) {
          console.log(chalk.bold.cyan('\n  ApiGen — Metrics\n'));
          console.log(`  Raw Requests:           ${chalk.green(rawRequests)}`);
          console.log(`  Deduplicated Endpoints: ${chalk.green(endpoints)}`);
          console.log(`  Schema Confidence:      ${chalk.green(schemaConfidence === null ? 'n/a' : `${schemaConfidence}%`)}`);
          console.log(`  Failed Body Parses:     ${chalk.green(parseFailures)}`);
          console.log(`  Filtered Telemetry:     ${chalk.green(telemetryDrops)}`);
          console.log(`  GraphQL Ops:            ${chalk.green(gqlOps)}`);
          console.log(`  Replay Success Rate:    ${chalk.green(replaySuccessRate === null ? 'n/a' : `${replaySuccessRate}%`)}`);
          console.log('');
        }

        if (wantJson) {
          console.log(JSON.stringify(metrics, null, 2));
        }
      } catch {
        console.log(chalk.red('  No database found. Run capture/crawl first.'));
      }
    });
}
