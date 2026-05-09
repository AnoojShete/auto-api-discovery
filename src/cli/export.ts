/**
 * CLI command: export
 * L8: OpenAPI specification export
 * 
 * Usage: apigen export <outfile> [--base-url <url>] [--validate] [--only-approved]
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { generateOpenAPISpec, validateSpec, ExportOptions } from '../export/openapi';
import { getAllEndpoints } from '../db/endpoints';

export function registerExportCommand(program: Command): void {
  program
    .command('export <outfile>')
    .description('Export OpenAPI 3.0 specification from discovery database')
    .option('-b, --base-url <url>', 'Base URL for the API', 'http://localhost')
    .option('--title <title>', 'API title', 'Auto-Discovered API')
    .option('--version <version>', 'API version', '1.0.0')
    .option('--validate', 'Validate the output specification')
    .option('--only-approved', 'Only include approved endpoints')
    .action((outfile: string, options: any) => {
      console.log(chalk.bold.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('  ║        ApiGen — Export Mode          ║'));
      console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝\n'));

      // Check if there are endpoints
      const endpoints = getAllEndpoints();
      if (endpoints.length === 0) {
        console.log(chalk.red('  ✗ No endpoints found in database.'));
        console.log(chalk.gray('    Run `apigen capture` or `apigen crawl` first.\n'));
        process.exit(0);
      }

      console.log(chalk.yellow(`  Endpoints found: ${endpoints.length}`));

      // Generate spec
      const exportOptions: ExportOptions = {
        baseUrl: options.baseUrl,
        title: options.title,
        version: options.version,
        onlyApproved: options.onlyApproved,
        validate: options.validate,
      };

      const spec = generateOpenAPISpec(exportOptions);

      // Validate if requested
      if (options.validate) {
        const errors = validateSpec(spec);
        if (errors.length > 0) {
          console.log(chalk.red('\n  ✗ Validation errors:'));
          for (const err of errors) {
            console.log(chalk.red(`    • ${err}`));
          }
          console.log('');
          process.exit(1);
        }
        console.log(chalk.green('  ✓ Specification validates successfully'));
      }

      // Warn on low-confidence endpoints
      const lowConfidence = endpoints.filter(ep => ep.observation_count < 3);
      if (lowConfidence.length > 0) {
        console.log(chalk.yellow(`  ⚠ ${lowConfidence.length} endpoints have fewer than 3 observations (low confidence)`));
      }

      // Write output
      const format = outfile.endsWith('.yaml') || outfile.endsWith('.yml') ? 'yaml' : 'json';
      
      if (format === 'json') {
        fs.writeFileSync(outfile, JSON.stringify(spec, null, 2), 'utf-8');
      } else {
        // For now, export as JSON even for .yaml extension
        // TODO: Add js-yaml dependency for proper YAML output
        fs.writeFileSync(outfile, JSON.stringify(spec, null, 2), 'utf-8');
        console.log(chalk.yellow('  ⚠ YAML output not yet supported — exported as JSON'));
      }

      console.log(chalk.bold.green(`\n  ✓ Export complete: ${outfile}`));

      // Summary stats
      const pathCount = Object.keys((spec as any).paths || {}).length;
      console.log(chalk.gray(`    Paths:     ${pathCount}`));
      console.log(chalk.gray(`    Endpoints: ${endpoints.length}`));
      console.log(chalk.gray(`    Base URL:  ${options.baseUrl}\n`));
    });
}
