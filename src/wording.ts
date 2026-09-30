/** "1 film", "2 films". */
export function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A titled list after a blank line, or nothing when there are no items. */
export function section<T>(title: string, items: T[], line: (item: T) => string): string[] {
  return items.length === 0 ? [] : ["", title, ...items.map((item) => `- ${line(item)}`)];
}
