#!/usr/bin/env node
/**
 * `npm run db:up` / `npm run db:down`.
 *
 * A thin wrapper around `docker compose`, for one reason: when Docker is not
 * running, Docker's own message is this —
 *
 *   unable to get image 'mongo:8': error during connect: Get
 *   "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/images/mongo:8/json":
 *   open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file
 *   specified.
 *
 * which is a named pipe, a URL-encoded path and an API version, and nowhere
 * does it say "start Docker Desktop". This checks the two things that actually
 * go wrong — Docker missing, or the daemon down — and says which, before
 * handing over to compose.
 *
 * Plain JavaScript on purpose: it runs before anything is built.
 */

const {spawnSync} = require('node:child_process');

const SHELL = process.platform === 'win32';
const ATLAS =
  'No Docker? Put a MongoDB Atlas connection string in .env as DATABASE_URI\n' +
  '  and skip this step entirely.';

function quiet(cmd, args) {
  return spawnSync(cmd, args, {stdio: 'pipe', shell: SHELL, encoding: 'utf8'});
}

function fail(lines) {
  console.error('');
  for (const line of lines) console.error('  ' + line);
  console.error('');
  process.exit(1);
}

// 1. Is Docker installed at all?
if (quiet('docker', ['--version']).status !== 0) {
  fail([
    'Docker is not installed, or not on your PATH.',
    '',
    'This project uses it to run MongoDB as a replica set, which is what',
    '  Parse needs for transactions.',
    '',
    '  Install Docker Desktop:  https://docs.docker.com/get-started/get-docker/',
    '',
    ATLAS,
  ]);
}

// 2. Installed, but is the daemon actually up? This is the common case, and
//    the one whose native error is unreadable.
if (quiet('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0) {
  fail([
    'Docker is installed, but the Docker daemon is not running.',
    '',
    process.platform === 'win32' || process.platform === 'darwin'
      ? '  Start Docker Desktop, wait for the whale icon to settle, then retry.'
      : '  Start it with:  sudo systemctl start docker',
    '',
    ATLAS,
  ]);
}

// 3. Hand over. `docker compose` (v2) is what the compose file targets.
//    Output is inherited, so Docker's own progress and errors show through.
const action = process.argv[2] === 'down' ? ['down'] : ['up', '-d'];
const result = spawnSync('docker', ['compose', ...action], {
  stdio: ['inherit', 'inherit', 'pipe'],
  shell: SHELL,
  encoding: 'utf8',
});

if (result.stderr) process.stderr.write(result.stderr);

if (result.status !== 0) {
  const err = result.stderr || '';

  // By far the most common failure once Docker IS running: something else
  // already holds 27017 — usually a MongoDB from another project, or a
  // container this project left behind under a different name.
  if (/port is already allocated|address already in use|Bind for .*:27017/i.test(err)) {
    fail([
      'Port 27017 is already in use — something else is serving MongoDB.',
      '',
      'Usually another project\'s container. See what has it:',
      '',
      '  docker ps --filter publish=27017',
      '',
      'Then stop that one, or change the host port in docker-compose.yml',
      '  (for example "27018:27017") and set the new port in DATABASE_URI.',
    ]);
  }

  if (/is not a docker command|unknown shorthand flag/i.test(err)) {
    fail([
      'Your Docker has Compose v1, which this project does not target.',
      '',
      'Use `docker-compose up -d` instead, or upgrade Docker Desktop.',
    ]);
  }

  fail(['docker compose failed — its output is above.']);
}
