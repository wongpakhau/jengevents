import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import {
  LOCAL_LOGIN_PATH,
  PASSWORD_MIN_LENGTH,
  normalizeUsername,
  type LocalLoginResult,
} from "@shared/local-login";

/**
 * Username/password sign-in created by the organiser on the access page.
 * Staff and merchant accounts land on their workspace; member accounts open
 * the guest page with a fresh invitation in the URL hash.
 */
export default function LocalLoginForm({
  title = "帳號密碼登入",
  hint = "由大會建立的帳號；商家、工作人員或會員皆可使用。",
  compact = false,
}: {
  title?: string;
  hint?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(!compact);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch(LOCAL_LOGIN_PATH, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: normalizeUsername(username),
          password,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | (LocalLoginResult & { error?: string })
        | { error?: string }
        | null;
      if (!response.ok || !data || !("kind" in data)) {
        throw new Error(
          (data && "error" in data && data.error) ||
            "登入未完成，請檢查帳號與密碼。"
        );
      }
      // Both branches do a full navigation so the new cookie / invite hash is
      // picked up by a clean page load.
      window.location.assign(
        data.kind === "staff" ? data.returnTo || "/" : data.path
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登入失敗，請重試。");
      setBusy(false);
    }
  }

  if (compact && !open)
    return (
      <button
        type="button"
        className="button button-white local-login-toggle"
        onClick={() => setOpen(true)}
      >
        <KeyRound size={16} aria-hidden="true" /> 用帳號密碼登入
      </button>
    );

  return (
    <form
      className="local-login-form"
      onSubmit={event => void submit(event)}
      aria-label={title}
    >
      <strong>
        <KeyRound size={16} aria-hidden="true" /> {title}
      </strong>
      <label>
        <span>帳號</span>
        <input
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          value={username}
          onChange={event => setUsername(event.target.value)}
          required
          minLength={3}
          maxLength={32}
          placeholder="例如 merchant1"
        />
      </label>
      <label>
        <span>密碼</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={128}
        />
      </label>
      {error && (
        <p className="mvp-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="button button-dark"
        disabled={busy || !username.trim() || !password}
      >
        {busy ? "登入中…" : "登入"}
      </button>
      <small>{hint}</small>
    </form>
  );
}
