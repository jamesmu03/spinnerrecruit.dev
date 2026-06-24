import { createInterface } from "readline";
import type { Config } from "./config";

export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Until the user explicitly opts in, spinner-recruit makes zero network calls
// and the wrapped command runs completely untouched.
export async function runConsentPrompt(config: Config): Promise<Config> {
  console.log(
    "\nspinner-recruit: while your AI coding assistant is thinking, a one-line\n" +
      "purple job listing appears on its own status line underneath — its own\n" +
      "output is never touched or replaced. You earn 50% of paid-ad impression revenue\n" +
      "(clicks don't pay extra — no reason to click your own ads). Curated\n" +
      "listings are free and earn $0. No code, file names, or file contents are\n" +
      "ever sent.\n",
  );
  const answer = await ask("Enable this? [y/N] ");
  return { ...config, consented: /^y/i.test(answer.trim()) };
}
