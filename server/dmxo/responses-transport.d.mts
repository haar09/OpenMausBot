export type AzureFetch = (url: string, init: RequestInit) => Promise<Response>;
export function withAzureResponses(baseFetch: AzureFetch): AzureFetch;
