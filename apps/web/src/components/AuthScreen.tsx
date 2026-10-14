import { useState } from "react";
import { login, register, type User } from "../lib/api.ts";

interface Props {
  onAuth: (user: User) => void;
  onGuest: () => void;
}

/** Pantalla de entrada: iniciar sesión o crear cuenta (o explorar sin cuenta). */
export function AuthScreen({ onAuth, onGuest }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === "login" ? await login(email, password) : await register(email, password, name);
      onAuth(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo conectar con el servidor");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo">crom<b>a</b></span>
          <span className="kicker">studio</span>
        </div>
        <p className="auth-lede">Tu probador virtual y asesor de estilo.</p>

        <div className="seg auth-seg">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>
            Entrar
          </button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>
            Crear cuenta
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          {mode === "register" && (
            <label className="auth-field">
              <span>Nombre</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Tu nombre" />
            </label>
          )}
          <label className="auth-field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="tu@email.com" required />
          </label>
          <label className="auth-field">
            <span>Contraseña</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder="6+ caracteres"
              required
            />
          </label>

          {error && <p className="auth-error">{error}</p>}

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "Un momento…" : mode === "login" ? "Entrar" : "Crear cuenta"}
          </button>
        </form>

        <button className="auth-guest" type="button" onClick={onGuest}>
          Explorar sin cuenta →
        </button>
      </div>
    </div>
  );
}
