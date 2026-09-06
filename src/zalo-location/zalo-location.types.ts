export interface ZaloLocationResponse {
  latitude: number;
  longitude: number;
  provider: string | null;
  timestamp: number | null;
}

export interface ZaloLocationApiPayload {
  data?: {
    provider?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    timestamp?: unknown;
  };
  error?: unknown;
  message?: unknown;
}
