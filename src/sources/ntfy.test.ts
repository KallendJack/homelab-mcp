import { describe, expect, it } from "vitest";
import { fakeFetch } from "../testing/fake-fetch.ts";
import { ntfy } from "./ntfy.ts";
import { SourceError } from "./source-error.ts";

const url = "https://push.example";
const topic = "test-topic-0123456789";

describe("ntfy", () => {
  it("posts the message to the topic, with its title in a header", async () => {
    const fake = fakeFetch({ [`${url}/${topic}`]: { body: "{}" } });
    await ntfy(fake.fetch, url, topic).send({
      title: "recreate_service done",
      message: "Recreated dashboard.",
      failed: false,
    });
    const [request] = fake.requests;
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.body).toBe("Recreated dashboard.");
    expect(request?.init?.headers).toMatchObject({
      Title: "recreate_service done",
      Tags: "white_check_mark",
    });
  });

  it("marks a failure as urgent, so the phone makes itself heard", async () => {
    const fake = fakeFetch({ [`${url}/${topic}`]: { body: "{}" } });
    await ntfy(fake.fetch, url, topic).send({
      title: "pull_config failed",
      message: "x",
      failed: true,
    });
    expect(fake.requests[0]?.init?.headers).toMatchObject({ Tags: "warning", Priority: "high" });
  });

  it("says so in a sentence that never names the topic when ntfy refuses", async () => {
    const fake = fakeFetch({ [`${url}/${topic}`]: { status: 429, body: "too many" } });
    const error = await ntfy(fake.fetch, url, topic)
      .send({ title: "t", message: "m", failed: false })
      .catch((e: unknown) => e);
    expect(error).toEqual(new SourceError("ntfy answered with HTTP 429."));
    expect(String((error as Error).message)).not.toContain(topic);
  });
});
