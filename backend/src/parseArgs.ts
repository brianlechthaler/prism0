export type CliArgs = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  modelPickerEnabled?: boolean;
  yoloModeEnabled?: boolean;
  authEnabled?: boolean;
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
    } else if (token === "--enable-model-picker") {
      args.modelPickerEnabled = true;
    } else if (token === "--disable-model-picker") {
      args.modelPickerEnabled = false;
    } else if (token === "--enable-yolo-mode") {
      args.yoloModeEnabled = true;
    } else if (token === "--disable-yolo-mode") {
      args.yoloModeEnabled = false;
    } else if (token === "--enable-login") {
      args.authEnabled = true;
    } else if (token === "--disable-login") {
      args.authEnabled = false;
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
