/** "1 film", "2 films". */
export function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A titled list after a blank line, or nothing when there are no items. */
export function section<T>(title: string, items: T[], line: (item: T) => string): string[] {
  return items.length === 0 ? [] : ["", title, ...items.map((item) => `- ${line(item)}`)];
}

/** "2026-09-30 06:00 UTC": the Host's own time zone isn't known here. */
export function utcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
