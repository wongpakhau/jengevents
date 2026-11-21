import { useRef, useState } from "react";
import { startParticipantSession } from "@/lib/participant-session";
import "@/styles/participant-session.css";

export type ParticipantLoginButtonProps = {
  className?: string;
  disabled?: boolean;
};
/** Place after, not instead of, the existing Google primary login button. */
export function ParticipantLoginButton({
  className = "",
  disabled = false,
}: ParticipantLoginButtonProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const startingRef = useRef(false);
  const start = async () => {
    if (disabled || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError("");
    try {
      await startParticipantSession();
      // Never honor a workspace returnTo or any invitation/backend redirect.
      window.location.assign("/participant");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "未能開始臨時登入，請重試。"
      );
      startingRef.current = false;
      setStarting(false);
    }
  };
  return (
    <div className={`participant-login ${className}`.trim()}>
      <p>沒有 Google 帳戶？</p>
      <button
        type="button"
        className="participant-button participant-button--secondary"
        disabled={disabled || starting}
        onClick={() => void start()}
      >
        {starting ? "正在登入…" : "使用臨時帳戶"}
      </button>
      <small>只供活動參與者，20小時後自動登出</small>
      {error && (
        <p className="participant-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export default ParticipantLoginButton;
