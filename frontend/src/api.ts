export type ApiFetchOptions = RequestInit & {
  json?: unknown;
};

export async function apiFetch(input: string, options: ApiFetchOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  let body = options.body;

  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }

  return fetch(input, {
    ...options,
    headers,
    body,
    credentials: "include"
  });
}

export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  return text || res.statusText || "Request failed";
}
