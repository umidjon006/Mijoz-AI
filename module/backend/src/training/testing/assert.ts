/** Juda kichik test yordamchilari (tashqi test-runner ishlatilmaydi). */

export interface TestReport {
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

export function createReport(): TestReport {
  return { passed: 0, failed: 0, skipped: 0, failures: [] };
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

export function check(report: TestReport, name: string, fn: () => void): void {
  try {
    fn();
    report.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    report.failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    report.failures.push(`${name}: ${msg}`);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}

export async function checkAsync(
  report: TestReport,
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    report.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    report.failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    report.failures.push(`${name}: ${msg}`);
    console.log(`  FAIL ${name}\n       ${msg}`);
  }
}

export function skip(report: TestReport, name: string, why: string): void {
  report.skipped += 1;
  console.log(`  skip ${name} (${why})`);
}

export function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

export function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: kutilgan ${String(expected)}, kelgan ${String(actual)}`);
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n       kutilgan: ${b}\n       kelgan:   ${a}`);
}

export async function assertThrows(
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
  msg: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (predicate(err)) return;
    throw new Error(`${msg}: boshqa xato keldi — ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new Error(`${msg}: xato tashlanmadi`);
}
