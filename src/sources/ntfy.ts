import { httpRequests } from "./http.ts";
import { SourceError } from "./source-error.ts";

/** One push message to the person's phone, saying an Action ran and how it ended. */
export type Notification = { title: string; message: string; failed: boolean };

export type Notifier = { send(notification: Notification): Promise<void> };

/**
 * Sends Notifications through ntfy at `url` to `topic`. On a public ntfy server the topic is the only Secret: anyone
 * who has it can read the messages or send fakes. It is part of the address by ntfy's design, so no error names it.
 */
export function ntfy(fetch: typeof globalThis.fetch, url: string, topic: string): Notifier {
  const { post } = httpRequests(fetch, url, "ntfy");
  return {
    async send({ title, message, failed }) {
      const headers: Record<string, string> = failed
        ? { Title: title, Tags: "warning", Priority: "high" }
        : { Title: title, Tags: "white_check_mark" };
      const { status } = await post(`/${encodeURIComponent(topic)}`, {
        text: message,
        headers,
        // A hung ntfy mustn't hold the one-Action lock, which waits for this.
        timeLimited: true,
      });
      if (status < 200 || status >= 300)
        throw new SourceError(`ntfy answered with HTTP ${status}.`);
    },
  };
}
