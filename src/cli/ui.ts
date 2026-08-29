import {createInterface} from 'node:readline';

/**
 * Terminal output and prompts, without a dependency.
 *
 * A CLI shipped inside a runtime library must not drag `chalk`, `prompts` and
 * `commander` into every server install. Colour is eight escape codes and a
 * prompt is `readline`; that is the whole cost of keeping this package's
 * dependency list empty.
 */

const useColour =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code: string) => (text: string) =>
  useColour ? `[${code}m${text}[0m` : text;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');

export function info(message = ''): void {
  console.log(message);
}

export function ok(message: string): void {
  console.log(`${green('✓')} ${message}`);
}

export function warn(message: string): void {
  console.log(`${yellow('!')} ${message}`);
}

export function fail(message: string): void {
  console.error(`${red('✗')} ${message}`);
}

/**
 * Ask a question, offering a default.
 *
 * Falls straight through to the default when stdin is not a TTY, so the CLI
 * works unattended in CI without needing `--yes` to be threaded everywhere.
 */
export async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;

  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await new Promise<string>(resolve =>
      rl.question(`${question} ${dim(`(${fallback})`)} `, resolve)
    );
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = await ask(`${question} ${dim(`[${hint}]`)}`, fallback ? 'y' : 'n');
  return /^y/i.test(answer);
}

export interface Choice {
  id: string;
  label: string;
  /** Shown dimmed after the label, so the consequence of choosing is visible. */
  summary?: string;
}

/**
 * Offer a numbered list and take several answers.
 *
 * Numbers rather than arrow keys, deliberately: reading raw keypresses means
 * putting stdin in raw mode and reimplementing line editing, backspace and
 * ctrl-c by hand. `1,3` typed into `readline` works over SSH, inside every CI
 * runner, and in terminals that do not report as a TTY at all.
 *
 * `0` means none. Empty input takes the default. Unrecognised entries are
 * ignored rather than rejected — a stray comma should not restart the prompt.
 */
export async function choose(
  question: string,
  choices: Choice[],
  defaults: string[] = []
): Promise<string[]> {
  if (!process.stdin.isTTY) return defaults;

  const width = Math.max(...choices.map(c => c.label.length));

  info();
  info(`  ${bold(question)}`);
  info();
  choices.forEach((choice, index) => {
    const marker = defaults.includes(choice.id) ? cyan('•') : ' ';
    const label = choice.label.padEnd(width);
    info(`   ${marker} ${dim(String(index + 1))}  ${label}  ${dim(choice.summary ?? '')}`);
  });
  info(`     ${dim('0')}  none`);
  info();

  const fallback = defaults
    .map(id => choices.findIndex(c => c.id === id) + 1)
    .filter(n => n > 0)
    .join(',');

  const answer = await ask(
    `  ${dim('Numbers, comma separated')}`,
    fallback || '0'
  );

  if (/^\s*0\s*$/.test(answer)) return [];

  const picked = answer
    .split(/[,\s]+/)
    .map(part => Number.parseInt(part, 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= choices.length)
    .map(n => choices[n - 1].id);

  // De-duplicate while keeping the order they were typed in.
  return [...new Set(picked)];
}
