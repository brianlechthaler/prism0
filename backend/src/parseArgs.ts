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

    if (token === "--api-key" && next) {
      args.apiKey = next;
      i++;
    } else if (token === "--base-url" && next) {
      args.baseUrl = next;
      i++;
    } else if (token === "--model" && next) {
      args.model = next;
      i++;
    } else if (token === "--host" && next) {
      args.host = next;
      i++;
    } else if (token === "--port" && next) {
      args.port = Number(next);
      i++;
    }
  }

  return args;
}
