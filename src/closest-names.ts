/** Up to three names that contain what was asked for, or are a few typos away from it, ignoring case. */
export function closestNames(wanted: string, names: string[]): string[] {
  const target = wanted.toLowerCase();
  const allowedTypos = Math.max(2, Math.floor(target.length / 3));
  return names
    .map((name) => {
      const lower = name.toLowerCase();
      return { name, distance: lower.includes(target) ? 0 : editDistance(target, lower) };
    })
    .filter(({ distance }) => distance <= allowedTypos)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ name }) => name);
}

/** How many single-letter changes (add, remove or swap one letter for another) turn `a` into `b`. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const change = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + change,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
