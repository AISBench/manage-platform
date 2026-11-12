import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './db.js';
import { migrateLegacyMembers, provisionAdmin, resolveGitHubUser } from './members.js';

/** SQLite's online backup includes committed WAL pages; never copy the live main file. */
export async function backupDatabase(filename, output, { backupImpl = sqliteBackup } = {}) {
  const source = path.resolve(filename);
  const destination = path.resolve(output);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error('Backup source does not exist');
  if (source.toLowerCase() === destination.toLowerCase() || existsSync(destination)) throw new Error('Backup destination must be a new file distinct from the source');
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const actualDestination = path.join(realpathSync(path.dirname(destination)), path.basename(destination));
  if (realpathSync(source).toLowerCase() === actualDestination.toLowerCase()) throw new Error('Backup source and destination must differ');
  let db;
  let reserved = false;
  try {
    // Reserve the destination exclusively, including protection against existing symlinks.
    closeSync(openSync(destination, 'wx', 0o600)); reserved = true;
    db = new DatabaseSync(source, { readOnly: true });
    await backupImpl(db, destination);
    return { ok: true };
  } catch (error) {
    // This is only the newly reserved output, never an existing user file.
    if (reserved) unlinkSync(destination);
    throw error;
  } finally { db?.close(); }
}

function argumentsFor(argv) {
  const [command, ...args] = argv;
  if (!['bootstrap', 'recover-admin', 'migrate-members', 'backup'].includes(command)) throw new Error('Invalid command');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!['--github', '--output', '--database'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid command arguments');
    options[key] = value;
  }
  const permitted = command === 'backup' ? ['--output', '--database'] : command === 'migrate-members' ? ['--database'] : ['--github', '--database'];
  if (Object.keys(options).some(key => !permitted.includes(key)) || (command === 'backup' && !options['--output']) || (['bootstrap', 'recover-admin'].includes(command) && !options['--github'])) throw new Error('Missing or invalid command arguments');
  return { command, options };
}

export async function runCli(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, resolveUser, backupImpl = sqliteBackup } = {}) {
  let db;
  try {
    const { command, options } = argumentsFor(argv);
    const filename = options['--database'] || path.resolve(env.DATA_DIR || 'data', env.DEMO_MODE === 'true' ? 'demo.sqlite' : 'platform.sqlite');
    if (command === 'backup') {
      await backupDatabase(filename, options['--output'], { backupImpl });
      stdout.write('Consistent SQLite backup completed. Protect this file as sensitive data.\n');
      return 0;
    }
    if (env.DEMO_MODE === 'true') throw new Error('Membership CLI is unavailable in demo mode');
    const resolver = resolveUser || (login => resolveGitHubUser({ login, token: env.GITHUB_TOKEN || '' }));
    db = openDatabase(filename);
    if (command === 'migrate-members') {
      const list = value => (value || '').split(',').map(login => login.trim()).filter(Boolean);
      const report = await migrateLegacyMembers(db, { admins: list(env.ADMIN_GITHUB_LOGINS), allowed: list(env.ALLOWED_GITHUB_LOGINS), appId: env.FEISHU_APP_ID || '', resolveUser: resolver });
      stdout.write(report.skipped ? 'Membership already initialized; no changes made.\n' : `Membership migration completed: ${report.created} created, ${report.linkedUsers} profiles linked, ${report.unresolvedOwners} owners require review.\n`);
    } else {
      await provisionAdmin(db, { profile: await resolver(options['--github']), recover: command === 'recover-admin' });
      stdout.write(command === 'recover-admin' ? 'Explicit administrator recovery recorded.\n' : 'Administrator provisioned; complete verified GitHub login to activate.\n');
    }
    return 0;
  } catch {
    // Never print upstream bodies, request headers, OAuth credentials, open IDs, or exception stacks.
    stderr.write('Operation failed. Check command arguments, database access, verified identities, and initialization state. No credentials are printed.\n');
    return 1;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runCli();
