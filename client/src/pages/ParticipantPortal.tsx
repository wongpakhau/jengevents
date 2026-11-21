import { useState } from "react";
import ParticipantLoginButton from "@/components/event/ParticipantLoginButton";
import QRScanner from "@/components/event/QRScanner";
import { useVerifiedParticipantSession } from "@/components/event/ParticipantSessionGuard";
import {
  clearParticipantDevice,
  clearParticipantTab,
  getParticipantStatus,
  participantInvitePath,
  participantLinkPath,
  rememberParticipantInvite,
} from "@/lib/participant-session";
import { apiGuest } from "@/lib/eventflow-api";
import type { GuestView } from "@shared/eventflow";
import "@/styles/event-mobile.css";
import "@/styles/participant-session.css";

function remainingLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours} 小時 ${String(minutes).padStart(2, "0")} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}
function deadlineLabel(iso: string) {
  return new Intl.DateTimeFormat("zh-HK", {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(iso));
}

export default function ParticipantPortal() {
  const participant = useVerifiedParticipantSession();
  const [message, setMessage] = useState("");
  const expiredRoute =
    new URLSearchParams(window.location.search).get("expired") === "1";
  const session =
    participant.phase === "active" || participant.phase === "checking"
      ? participant.session
      : null;
  const myGuestPath = session ? participantInvitePath(session) : null;
  const handleScan = async (raw: string) => {
    if (
      !session ||
      participant.phase !== "active" ||
      participant.remainingMs <= 0
    )
      throw new Error("臨時登入已到期，請重新登入。");
    const path = participantLinkPath(raw);
    const verifyCurrent = async () => {
      const status = await getParticipantStatus();
      if (
        !status.session ||
        status.session.id !== session.id ||
        status.session.issuedAt !== session.issuedAt ||
        status.session.expiresAt !== session.expiresAt
      ) {
        if (status.session) clearParticipantTab();
        else clearParticipantDevice(true);
        window.location.assign("/participant?expired=1");
        throw new Error("臨時身份已改變或已到期，請重新登入。");
      }
    };
    await verifyCurrent();
    if (path.startsWith("/guest#invite=")) {
      const token = path.slice("/guest#invite=".length);
      const guest = await apiGuest<GuestView>("/guest", token);
      if (!guest?.guest?.id || !guest?.event?.id)
        throw new Error("此嘉賓邀請未獲確認，請向大會查詢。");
      await verifyCurrent();
      rememberParticipantInvite(token, session);
    }
    // Full navigation also unmounts the opt-in camera, and always stays local.
    window.location.assign(path);
  };
  const goToMyGuest = () => {
    if (!session || participant.phase !== "active") return;
    const path = participantInvitePath(session);
    if (path) window.location.assign(path);
    else
      setMessage(
        "尚未保存你的個人嘉賓邀請。請掃描大會登記 QR，完成登記；已有邀請則貼上你本人的完整連結。"
      );
  };

  return (
    <main
      className="participant-page"
      aria-busy={participant.phase === "checking"}
    >
      <header className="participant-header">
        <img src="/eventflow-mark.svg" width={36} height={36} alt="EventFlow" />
        <span>活動參與者</span>
      </header>
      {participant.phase === "checking" && (
        <section className="participant-card">
          <h1>正在確認登入狀態…</h1>
          <p role="status">只會在伺服器確認後顯示臨時帳戶內容。</p>
        </section>
      )}
      {participant.phase === "error" && (
        <section className="participant-card">
          <h1>暫時未能確認登入</h1>
          <p className="participant-error" role="alert">
            {participant.error}
          </p>
          <p>網絡錯誤不代表已登出。為保障私隱，暫不顯示個人內容。</p>
          <button
            type="button"
            className="participant-button"
            onClick={() => void participant.retry()}
          >
            重試
          </button>
        </section>
      )}
      {(participant.phase === "logged-out" ||
        participant.phase === "expired" ||
        participant.phase === "public") && (
        <section className="participant-card">
          <h1>
            {participant.phase === "expired" || expiredRoute
              ? "臨時帳戶已到期或已登出"
              : "你目前尚未登入"}
          </h1>
          <p role="status">
            {participant.phase === "expired" || expiredRoute
              ? "這個臨時身份已不能查看原有個人資料。請重新登入並向大會確認你的嘉賓邀請。"
              : "使用臨時帳戶不需要姓名、電話或密碼。登入後請掃描大會連結參與活動。"}
          </p>
          <ParticipantLoginButton />
        </section>
      )}
      {session && (
        <div
          hidden={participant.phase !== "active"}
          inert={participant.phase !== "active"}
        >
          <section className="participant-card">
            <p className="participant-status">已使用臨時帳戶登入</p>
            <h1>你的活動參與入口</h1>
            <p>你是活動參與者，非工作人員；此帳戶不能進入管理後台。</p>
            <dl className="participant-timing">
              <div>
                <dt>自動登出時間</dt>
                <dd>
                  <time dateTime={session.expiresAt}>
                    {deadlineLabel(session.expiresAt)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>剩餘時間</dt>
                <dd>{remainingLabel(participant.remainingMs)}</dd>
              </div>
            </dl>
            <p className="participant-help">
              自首次登入起固定 20 小時；刷新、掃碼或再次按登入不會延長。
            </p>
            <button
              type="button"
              className="participant-button participant-button--secondary"
              onClick={() => void participant.logout()}
            >
              登出臨時帳戶
            </button>
          </section>
          <section className="participant-card">
            <h2>掃描大會 QR 或貼上連結</h2>
            <p>
              只接受本站的大會登記頁或你本人的嘉賓邀請連結。相機預設關閉，可直接貼上完整連結。
            </p>
            <QRScanner
              title="大會活動連結"
              description="按下開啟後才會使用相機；不接受後台、外站或裸 token。"
              manualLabel="沒有相機？貼上大會或個人邀請連結"
              manualPlaceholder="貼上本站活動的完整連結"
              onDetect={handleScan}
              disabled={participant.phase !== "active"}
            />
          </section>
          <section className="participant-card">
            <h2>我的嘉賓頁</h2>
            <p>
              {myGuestPath
                ? "本裝置已保存與這個臨時身份關聯的個人嘉賓邀請。"
                : "尚未保存你的個人嘉賓邀請，請先掃描大會連結。"}
            </p>
            <button
              type="button"
              className="participant-button participant-button--secondary"
              onClick={goToMyGuest}
            >
              回我的嘉賓頁
            </button>
            {message && (
              <p className="participant-help" role="status">
                {message}
              </p>
            )}
          </section>
          <p className="participant-help participant-footnote">
            臨時登入本身不代表已完成活動登記或已到場。活動資料及簽到狀態以大會確認為準。
          </p>
        </div>
      )}
    </main>
  );
}
