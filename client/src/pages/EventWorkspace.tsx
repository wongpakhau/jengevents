import { RefreshCw, ScanLine } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { roleHome, roleHomeLabel } from "@/lib/role-home";
import AdminDraw from "@/components/event/AdminDraw";
import AdminFinance from "@/components/event/AdminFinance";
import AdminGuests from "@/components/event/AdminGuests";
import AdminMerchants from "@/components/event/AdminMerchants";
import AdminOverview from "@/components/event/AdminOverview";
import AdminSeating from "@/components/event/AdminSeating";
import AdminSettings from "@/components/event/AdminSettings";
import "@/styles/event-workspace.css";

export default function EventWorkspace() {
  const [location] = useLocation();
  const { state, eventId, loading, error, reload } = useWorkspace();

  if (loading)
    return (
      <main className="mvp-workspace">
        <div className="mvp-loading" role="status">
          正在讀取活動工作區…
        </div>
      </main>
    );
  if (error && !state) {
    return (
      <main className="mvp-workspace">
        <section className="mvp-empty">
          <h1>暫時未能讀取活動資料</h1>
          <p>{error}</p>
          <button className="button button-dark" onClick={() => void reload()}>
            <RefreshCw size={15} />
            重新載入
          </button>
        </section>
      </main>
    );
  }
  if (!state || !eventId)
    return (
      <main className="mvp-workspace">
        <section className="mvp-empty">
          <h1>尚未選擇活動</h1>
          <p>請先在工作區選擇一個可存取的活動，再開啟管理功能。</p>
        </section>
      </main>
    );

  const scopeAllowed =
    ["owner", "admin", "project_manager"].includes(state.role) ||
    (state.role === "merchant" && location === "/settlements") ||
    (state.role === "draw" && location === "/draw") ||
    (state.role === "guest_manager" &&
      ["/", "/guests", "/seating"].includes(location));
  if (!scopeAllowed) {
    const home = roleHome(state.role, state.event.mode);
    return (
      <main className="mvp-workspace">
        <section className="mvp-empty">
          <h1>此功能不在你的授權範圍</h1>
          <p>請使用已分配的工作台功能，或向大會管理員申請權限。</p>
          {home !== location && (
            <Link href={home} className="button button-dark">
              前往{roleHomeLabel(state.role, state.event.mode)}
            </Link>
          )}
        </section>
      </main>
    );
  }
  const attendanceOnly = state.event.mode === "attendance";
  const unavailable =
    attendanceOnly &&
    ["/merchants", "/settlements", "/draw"].includes(location);
  if (unavailable) {
    return (
      <main className="mvp-workspace">
        <section className="mvp-empty">
          <h1>此典禮未啟用此功能</h1>
          <p>
            簽到典禮模式只使用嘉賓管理、圍枱安排、現場簽到與名單匯出；後端亦會拒絕消費及抽獎操作。
          </p>
        </section>
      </main>
    );
  }

  let page = <AdminOverview />;
  switch (location) {
    case "/":
      page = <AdminOverview />;
      break;
    case "/guests":
      page = <AdminGuests />;
      break;
    case "/seating":
      page = <AdminSeating />;
      break;
    case "/merchants":
      page = <AdminMerchants />;
      break;
    case "/settlements":
      page = <AdminFinance key={eventId} />;
      break;
    case "/draw":
      page = <AdminDraw />;
      break;
    case "/settings":
      page = <AdminSettings />;
      break;
    case "/checkin":
      page = (
        <section className="mvp-empty">
          <ScanLine size={30} />
          <h1>請使用現場簽到工作台</h1>
          <p>
            此路由由獨立的 CheckInDesk
            提供，讓簽到人員以手機或掃描裝置快速處理嘉賓到場。
          </p>
        </section>
      );
      break;
    default:
      page = (
        <section className="mvp-empty">
          <h1>找不到此工作區頁面</h1>
          <p>請從側欄選擇活動管理功能。</p>
        </section>
      );
  }
  return <main className="mvp-workspace">{page}</main>;
}
