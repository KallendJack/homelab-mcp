// A stand-in for `docker compose`, run as a real process by tests. Usage: node fake-compose.mjs <scenario.json> ...args
// The scenario maps the arguments, joined by spaces, to { stdout, stderr, exitCode }. Every call is appended to the
// scenario's "log" file, one JSON line per call, with the arguments and the DOCKER_HOST it was given.
import { appendFileSync, readFileSync } from "node:fs";

const [scenarioPath, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
appendFileSync(
  scenario.log,
  `${JSON.stringify({ args, dockerHost: process.env.DOCKER_HOST ?? null })}\n`,
);

const key = args.join(" ");
const answer = scenario.answers[key];
if (answer === undefined) {
  process.stderr.write(`fake compose has no answer for: ${key}\n`);
  process.exit(99);
}
if (answer.stdout) process.stdout.write(answer.stdout);
if (answer.stderr) process.stderr.write(answer.stderr);
process.exit(answer.exitCode ?? 0);
