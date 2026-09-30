/** How long any Source may take before its Tool gives up and says so. */
export const TIME_LIMIT_SECONDS = 10;

/**
 * The result of `work`, or of `onTimeout()` if `seconds` pass first. For work that can't be cancelled, such as
 * reading a disk: a hung network mount would otherwise leave the Tool waiting forever.
 */
export async function withinTimeLimit<T>(
  work: Promise<T>,
  seconds: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), seconds * 1000);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}
