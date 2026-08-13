import { normalizeOrigin } from "./config.ts";
import { TuiError } from "./errors.ts";
import {
  decodeJsonText,
  decodePairing,
  decodePairingCredential,
  type TuiConfig,
} from "./schemas.ts";
import { extractClientCookie, readBoundedText, type FetchImplementation } from "./transport.ts";

const PAIRING_MAX_RESPONSE_BYTES = 64 * 1024;

const readBoundedPairingResponse = async (response: Response): Promise<unknown> => {
  const decoded = decodeJsonText(await readBoundedText(response, PAIRING_MAX_RESPONSE_BYTES));
  if (decoded === undefined)
    throw new TuiError("pairing_failed", "Scotty returned an invalid pairing response");
  return decoded;
};

export const pairingCredentialFromInput = (input: string, expectedOrigin: string): string => {
  const trimmed = input.trim();
  const direct = decodePairingCredential(trimmed);
  if (direct !== undefined) return direct;
  if (!URL.canParse(trimmed))
    throw new TuiError("input_invalid", "Pairing input must be a credential or pairing URL");
  const url = new URL(trimmed);
  if (url.origin !== expectedOrigin || url.pathname !== "/pair")
    throw new TuiError("input_invalid", "Pairing URL must match the configured exact origin");
  const token = decodePairingCredential(new URLSearchParams(url.hash.slice(1)).get("token"));
  if (token === undefined)
    throw new TuiError("input_invalid", "Pairing URL does not contain a valid token");
  return token;
};

export const consumePairing = async (input: {
  readonly origin: string;
  readonly pairingInput: string;
  readonly label: string;
  readonly fetch?: FetchImplementation;
}): Promise<TuiConfig> => {
  const origin = normalizeOrigin(input.origin);
  const token = pairingCredentialFromInput(input.pairingInput, origin);
  const fetchImplementation = input.fetch ?? fetch;
  const endpoint = new URL("/api/auth/pairings/consume", origin);
  const response = await fetchImplementation(endpoint, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ token, label: input.label.slice(0, 100) }),
  });
  if (response.url && new URL(response.url).origin !== origin)
    throw new TuiError("pairing_failed", "Refused a cross-origin pairing response");
  const json = await readBoundedPairingResponse(response);
  const credential = extractClientCookie(response.headers.get("set-cookie"));
  if (!response.ok || decodePairing(json) === undefined || credential === undefined)
    throw new TuiError("pairing_failed", "Pairing was rejected", response.status);
  return { version: 1, origin, credential };
};
