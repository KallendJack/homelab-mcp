import { readFileSync } from "node:fs";

/** What the fake answers for one URL: a response, or an error to throw as a network failure would. */
export type FakeAnswer = { status?: number; body: string | Uint8Array<ArrayBuffer> } | Error;

export type FakeFetch = {
  fetch: typeof fetch;
  /** Every request made, in order, with the options it was made with. */
  requests: { url: string; init: RequestInit | undefined }[];
};

/** A `fetch` that answers from a table of URLs, for testing Sources without a network. */
export function fakeFetch(answers: Record<string, FakeAnswer>): FakeFetch {
  const requests: FakeFetch["requests"] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, init });
    const answer = answers[url];
    if (answer === undefined) throw new Error(`fake fetch has no answer for ${url}`);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body, { status: answer.status ?? 200 });
  };
  return { fetch: fake as typeof fetch, requests };
}

/** A recorded response from `fixtures/`, as the body of a fake answer. Read as bytes: log streams are binary. */
export function fixture(path: string): { body: Uint8Array<ArrayBuffer> } {
  return { body: new Uint8Array(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url))) };
}
