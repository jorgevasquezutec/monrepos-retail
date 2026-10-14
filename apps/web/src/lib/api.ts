/**
 * Cliente del backend de aplicación (@retail/api): auth + catálogo.
 * Guarda el token JWT en localStorage. Si la API no está, el llamador degrada
 * a modo local (catálogo de respaldo, sin cuenta).
 */
import type { Garment } from "@retail/style-engine";

// El backend arranca por defecto en 8787 (ver apps/api/src/server.ts).
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8787";
const TOKEN_KEY = "croma_token";

export interface User {
  id: number;
  email: string;
  name: string;
}

let token: string | null = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;

export function getToken(): string | null {
  return token;
}

function setToken(t: string | null): void {
  token = t;
  if (typeof localStorage === "undefined") return;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Error ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function register(email: string, password: string, name: string): Promise<User> {
  const r = await req<{ token: string; user: User }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  setToken(r.token);
  return r.user;
}

export async function login(email: string, password: string): Promise<User> {
  const r = await req<{ token: string; user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(r.token);
  return r.user;
}

export async function fetchMe(): Promise<User> {
  const r = await req<{ user: User }>("/auth/me");
  return r.user;
}

export function logout(): void {
  setToken(null);
}

export async function fetchCatalog(): Promise<Garment[]> {
  return req<Garment[]>("/catalog");
}

/** Datos de alta de una prenda (sin id; el backend lo genera). */
export type NewGarment = Omit<Garment, "id">;

export async function createGarment(g: NewGarment): Promise<Garment> {
  return req<Garment>("/catalog", { method: "POST", body: JSON.stringify(g) });
}
