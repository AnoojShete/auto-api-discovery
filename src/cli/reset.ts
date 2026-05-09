/**
 * CLI command: reset
 * Usage: apigen reset
 */
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { closeDb } from '../db/schema';

export function registerResetCommand(program: Command): void {
  program
    .command('reset')
    .description('Wipe the .apigen/ directory and start fresh')
    .action(() => {
      const apigenDir = path.resolve(process.cwd(), '.apigen');
      if (!fs.existsSync(apigenDir)) {
        console.log(chalk.yellow('  No .apigen directory found.\n'));
        return;
      }
      closeDb();
      fs.rmSync(apigenDir, { recursive: true, force: true });
      console.log(chalk.green('  ✓ .apigen/ directory removed. Clean slate.\n'));
    });
}
