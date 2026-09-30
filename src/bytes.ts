const UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

/**
 * Bytes in the units disks are sold in, counting in thousands, to three significant figures: 4.43 TB, 812 GB,
 * 71.2 MB. Rounds before choosing the unit, so 999,950 bytes is 1.00 MB rather than 1000 kB.
 */
export function humanBytes(bytes: number): string {
  let unit = 0;
  while (unit < UNITS.length - 1 && bytes >= 1000 ** (unit + 1)) unit++;
  let value = roundTo3Figures(bytes / 1000 ** unit);
  if (value >= 1000 && unit < UNITS.length - 1) {
    unit++;
    value = roundTo3Figures(bytes / 1000 ** unit);
  }
  const decimals = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

function roundTo3Figures(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(3));
}
