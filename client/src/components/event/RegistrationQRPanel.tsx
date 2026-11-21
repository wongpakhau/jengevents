import { QrCode, ExternalLink } from "lucide-react";
import type { EventInfo } from "@shared/eventflow";
import QRCode from "./QRCode";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import {
  hasRole,
  managerRoles,
  InlineError,
  useWorkspaceMutation,
} from "./AdminShared";

export default function RegistrationQRPanel() {
  const { state, eventId } = useWorkspace();
  const { mutate, isPending, errorFor } = useWorkspaceMutation();
  if (!state || !hasRole(state.role, managerRoles)) return null;
  const { event } = state;
  const active = event.registrationOpen && event.status !== "closed";
  const path = `/register/${encodeURIComponent(event.slug)}`;
  return (
    <section className="mvp-panel mvp-registration-qr-panel">
      <div>
        <span className="mvp-kicker">ONE QR · EVERY GUEST</span>
        <h2>
          <QrCode size={22} /> 現場嘉賓登記QR
        </h2>
        <p>
          {event.mode === "attendance"
            ? "嘉賓掃描後填寫姓名、班種（BP／格局／金魂／CBL）、班號及電話。無需登入大會帳戶。"
            : "嘉賓掃描後即可填寫資料，建立個人邀請。"}
        </p>
        <p className="mvp-inline-note">
          {active
            ? event.registrationCheckIn
              ? "已開啟現場模式：提交即記錄為已到場。"
              : "已開放登記：提交後仍需工作人員簽到。"
            : "登記入口目前關閉。可先下載QR，啟用後同一個QR即可使用。"}
        </p>
        <div className="mvp-inline-actions">
          <button
            className="button button-dark"
            disabled={
              event.status === "closed" || isPending("registration-enable")
            }
            onClick={() =>
              void mutate<EventInfo>(
                "registration-enable",
                `/events/${eventId}/settings`,
                "PATCH",
                { registrationOpen: true, registrationCheckIn: true }
              )
            }
          >
            {isPending("registration-enable")
              ? "正在啟用…"
              : "啟用現場登記（提交即到場）"}
          </button>
          <a href="/settings" className="button button-white">
            <ExternalLink size={15} /> 登記及私隱設定
          </a>
        </div>
        <p className="mvp-inline-note">
          共用QR不包含嘉賓個資。列印前請在成功發布的正式網站下載；預覽產生的QR只供暫時測試。提前發送登記連結時，請在設定關閉自助到場。
        </p>
        <InlineError message={errorFor("registration-enable")} />
      </div>
      <QRCode value={path} title="掃碼填寫嘉賓資料" />
    </section>
  );
}
