/**
 * CLI command: sessions
 * Usage: apigen sessions list | apigen sessions delete <label>
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { listSessions, deleteSessionByLabel } from '../db/sessions';

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command('sessions').description('Manage saved sessions');

  sessions
    .command('list')
    .description('List all saved sessions')
    .action(() => {
      const all = listSessions();
      if (all.length === 0) {
        console.log(chalk.yellow('  No sessions found.\n'));
        return;
      }
      console.log(chalk.white('\n  Saved Sessions:'));
      for (const s of all) {
        const date = new Date(s.created_at).toISOString();
        console.log(`  ${chalk.cyan(s.label || '(no label)')}  ${chalk.gray(date)}  ${chalk.gray(s.id)}`);
      }
      console.log('');
    });

  sessions
    .command('delete <label>')
    .description('Delete a session by label')
    .action((label: string) => {
      const deleted = deleteSessionByLabel(label);
      if (deleted) {
        console.log(chalk.green(`  ✓ Deleted session "${label}"`));
      } else {
        console.log(chalk.red(`  ✗ No session found with label "${label}"`));
      }
    });
}
