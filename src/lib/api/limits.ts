// D-90: the API's rate limit, shared by the request handling and the documentation. Pure.
export const API_RATE = { limit: 60, windowSeconds: 60 } as const;
