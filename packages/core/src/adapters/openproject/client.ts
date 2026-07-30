import { vendorRequest, type VendorHttpConfig } from "../http";
import type { OpenProjectTokenProvider } from "./types";

/** API root (no trailing slash) for an OpenProject instance. */
export function openprojectApiBase(baseUrl?: string): string {
  if (!baseUrl) throw new Error("OpenProject target requires a baseUrl");
  return baseUrl.replace(/\/+$/, "");
}

/** HTTP config for a given auth method. A PAT authenticates via HTTP Basic with
 *  the username `apikey` and the token as the password; OAuth uses the default
 *  Bearer header. */
function httpConfig(authMethod?: "oauth" | "pat"): VendorHttpConfig {
  const config: VendorHttpConfig = {
    vendor: "OpenProject",
    baseHeaders: { accept: "application/json" },
  };
  if (authMethod === "pat") {
    config.authHeader = (token) => `Basic ${Buffer.from(`apikey:${token}`).toString("base64")}`;
  }
  return config;
}

export async function openprojectGet<T>(
  url: string,
  getToken: OpenProjectTokenProvider,
  authMethod?: "oauth" | "pat",
): Promise<T> {
  return (await vendorRequest<T>(httpConfig(authMethod), "GET", url, getToken)).body as T;
}

export async function openprojectPost<T>(
  url: string,
  getToken: OpenProjectTokenProvider,
  body: unknown,
  authMethod?: "oauth" | "pat",
): Promise<T> {
  return (await vendorRequest<T>(httpConfig(authMethod), "POST", url, getToken, { body }))
    .body as T;
}
