export type CliArgs = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  host?: string;
  port?: number;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];
    const hasValue = Boolean(next && !next.startsWith("--"));

    if (token === "--api-key" && hasValue) {
      args.apiKey = next;
      i++;
    } else if (token === "--base-url" && hasValue) {
      args.baseUrl = next;
      i++;
    } else if (token === "--model" && hasValue) {
      args.model = next;
      i++;
    } else if (token === "--host" && hasValue) {
      args.host = next;
      i++;
    } else if (token === "--port" && hasValue) {
      args.port = Number(next);
      i++;
    }
  }

  return args;
}
