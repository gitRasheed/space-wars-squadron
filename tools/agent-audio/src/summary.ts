import type { CheckReport } from './types.js';

export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'ERROR';

export interface SummaryRow {
  readonly file: string;
  readonly verdict: Verdict;
  readonly durationS: string;
  readonly lufs: string;
  readonly truePeakDbtp: string;
  readonly centroidHz: string;
  readonly seam: string;
  readonly findings: string;
}

const COLUMNS: readonly { readonly key: keyof SummaryRow; readonly title: string }[] = [
  { key: 'file', title: 'FILE' },
  { key: 'verdict', title: 'VERDICT' },
  { key: 'durationS', title: 'DUR_S' },
  { key: 'lufs', title: 'LUFS' },
  { key: 'truePeakDbtp', title: 'DBTP' },
  { key: 'centroidHz', title: 'CENTROID_HZ' },
  { key: 'seam', title: 'SEAM' },
  { key: 'findings', title: 'FINDINGS' },
];

export function verdictOf(report: CheckReport): Verdict {
  if (!report.ok) {
    return 'FAIL';
  }
  return report.findings.length > 0 ? 'WARN' : 'PASS';
}

function fixed(value: number | null, digits: number): string {
  return value === null ? '-' : value.toFixed(digits);
}

export function summaryRow(report: CheckReport, label = report.file): SummaryRow {
  const { loudness } = report;
  // Integrated loudness needs 400 ms; shorter files show their momentary maximum, prefixed M.
  const lufs =
    loudness.integratedLufs !== null
      ? `I${fixed(loudness.integratedLufs, 1)}`
      : loudness.momentaryMaxLufs !== null
        ? `M${fixed(loudness.momentaryMaxLufs, 1)}`
        : '-';
  const seamRatios = report.channels.flatMap((c) => (c.loopSeam !== null ? [c.loopSeam.discontinuityRatio] : []));
  return {
    file: label,
    verdict: verdictOf(report),
    durationS: report.format.durationS.toFixed(3),
    lufs,
    truePeakDbtp: fixed(report.loudness.truePeakDbtp, 1),
    centroidHz: report.spectral.centroidHz.toFixed(0),
    seam: seamRatios.length > 0 ? Math.max(...seamRatios).toFixed(2) : '-',
    findings: report.findings.length > 0 ? [...new Set(report.findings.map((f) => f.code))].join(',') : '-',
  };
}

export function errorRow(file: string, code: string): SummaryRow {
  return {
    file,
    verdict: 'ERROR',
    durationS: '-',
    lufs: '-',
    truePeakDbtp: '-',
    centroidHz: '-',
    seam: '-',
    findings: code,
  };
}

/** One aligned line per row under a header; the last column is never padded. */
export function formatSummaryTable(rows: readonly SummaryRow[]): string {
  const widths = COLUMNS.map(({ key, title }) => Math.max(title.length, ...rows.map((r) => r[key].length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [
    line(COLUMNS.map((c) => c.title)),
    ...rows.map((r) => line(COLUMNS.map((c) => r[c.key]))),
  ].join('\n');
}
