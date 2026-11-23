import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Users,
  Armchair,
  ScanLine,
  Store,
  ReceiptText,
  Gift,
  Palette,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  Menu,
  X,
  CircleHelp,
} from "lucide-react";
import type { ReactNode } from "react";
import { useWorkspace } from "@/contexts/EventWorkspaceContext";
import { useAuth } from "@/_core/hooks/useAuth";

type NavigationItem = {
  path: string;
  name: string;
  icon: typeof LayoutDashboard;
  group?: string;
  feature?: "commerce" | "draw";
};

export const navigation: NavigationItem[] = [
  { path: "/", name: "活動總覽", icon: LayoutDashboard, group: "活動管理" },
  { path: "/guests", name: "嘉賓管理", icon: Users },
  { path: "/seating", name: "圍枱安排", icon: Armchair },
  { path: "/checkin", name: "現場簽到", icon: ScanLine },
  {
    path: "/merchants",
    name: "商戶管理",
    icon: Store,
    group: "消費與互動",
    feature: "commerce",
  },
  {
    path: "/settlements",
    name: "交易與對帳",
    icon: ReceiptText,
    feature: "commerce",
  },
  { path: "/draw", name: "抽獎控制", icon: Gift, feature: "draw" },
  { path: "/settings", name: "白牌設定", icon: Palette, group: "平台設定" },
];

export default function EventShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const { session, state, eventId, setEventId } = useWorkspace();
  const { logout } = useAuth();
  if (!session || !state) return null;

  const event = state.event;
  const attendanceOnly = event.mode === "attendance";
  const organization = session.organizations.find(o => o.id === event.tenantId);
  const roleNames = {
    owner: "大會擁有人",
    admin: "活動管理員",
    project_manager: "Project Manager",
    guest_manager: "嘉賓及圍枱管理員",
    checkin: "簽到工作人員",
    draw: "抽獎工作人員",
    merchant: "商戶工作人員",
  };
  const activeNavigation = navigation.filter(
    item => !(attendanceOnly && item.feature)
  );
  const allowed =
    state.role === "owner" ||
    state.role === "admin" ||
    state.role === "project_manager"
      ? activeNavigation
      : activeNavigation.filter(
          item =>
            (state.role === "checkin" && item.path === "/checkin") ||
            (state.role === "merchant" && item.path === "/settlements") ||
            (state.role === "draw" && item.path === "/draw") ||
            (state.role === "guest_manager" &&
              ["/", "/guests", "/seating", "/checkin"].includes(item.path))
        );
  const current =
    activeNavigation.find(item => item.path === location)?.name ?? "活動工作區";

  return (
    <div className="event-app">
      {open && (
        <button
          className="sidebar-scrim"
          aria-label="關閉選單"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`event-sidebar ${open ? "is-open" : ""}`}>
        <Link href="/" className="wordmark">
          <img
            src={event.brand.logoUrl || "/eventflow-mark.svg"}
            alt=""
            referrerPolicy="no-referrer"
          />
          <span>
            {event.brand.name || "EventFlow"}
            <small>
              {attendanceOnly ? "典禮簽到與座位管理" : "每個精彩，井然有序。"}
            </small>
          </span>
        </Link>
        <button
          className="sidebar-close"
          aria-label="關閉選單"
          onClick={() => setOpen(false)}
        >
          <X size={20} />
        </button>
        <div className="workspace-name">
          <div className="workspace-initial">
            {(organization?.name || "E").slice(0, 1)}
          </div>
          <div>
            <strong>{organization?.name || "已授權活動"}</strong>
            <small>{roleNames[state.role]}</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <nav aria-label="主要導覽">
          {session.canManageAccess && (
            <Link href="/access" className="nav-link">
              <Users size={18} />
              <span>帳戶與角色授權</span>
            </Link>
          )}
          {allowed.map(item => (
            <div key={item.path}>
              {item.group && <p className="nav-group">{item.group}</p>}
              <Link
                href={item.path}
                className={`nav-link ${location === item.path ? "active" : ""}`}
                onClick={() => setOpen(false)}
              >
                <item.icon size={18} strokeWidth={1.7} />
                <span>{item.name}</span>
                {location === item.path && <span className="nav-dot" />}
              </Link>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link
            href={
              attendanceOnly
                ? "/checkin"
                : state.role === "merchant"
                  ? "/merchant"
                  : `/screen?event=${eventId}`
            }
            className="screen-link"
          >
            {attendanceOnly ? <ScanLine size={18} /> : <Gift size={18} />}
            <div>
              <strong>
                {attendanceOnly
                  ? "現場簽到工作台"
                  : state.role === "merchant"
                    ? "商戶結帳端"
                    : "大屏幕舞台"}
              </strong>
              <small>
                {attendanceOnly
                  ? "掃QR或搜尋嘉賓簽到"
                  : state.role === "merchant"
                    ? "輸入金額、發出憑證"
                    : "普通三軸捲動揭曉"}
              </small>
            </div>
            <ArrowUpRight size={18} />
          </Link>
          <div className="sidebar-help">
            <CircleHelp size={15} />
            <span>MVP · 資料持久保存</span>
          </div>
          <div className="sidebar-user">
            <span className="user-avatar">
              {(session.user.name || "U").slice(0, 2)}
            </span>
            <div>
              <strong>{session.user.name || "已登入用戶"}</strong>
              <small>{roleNames[state.role]}</small>
            </div>
            <button
              onClick={async () => {
                await logout();
                window.location.assign("/");
              }}
            >
              登出
            </button>
          </div>
        </div>
      </aside>
      <div className="event-main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu icon-button"
              aria-label="開啟選單"
              onClick={() => setOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>工作空間</span>
            <ChevronRight size={13} />
            <strong>{current}</strong>
          </div>
          <div className="topbar-right">
            <span className="prototype-tag">
              {attendanceOnly ? "典禮模式" : "MVP"}
            </span>
            <Link href={`/register/${event.slug}`} className="topbar-link">
              嘉賓登記頁 <ArrowUpRight size={14} />
            </Link>
          </div>
        </header>
        <main className="work-area">
          <div className="event-selector">
            <span className="event-selector-symbol">E</span>
            <select
              aria-label="切換活動"
              value={eventId}
              onChange={event => setEventId(event.target.value)}
            >
              {session.events.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <span className="event-year">{event.date.slice(0, 4)}</span>
            <span className="event-state">
              <span />
              {
                { draft: "籌備中", live: "活動進行中", closed: "已結束" }[
                  event.status
                ]
              }
            </span>
          </div>
          {children}
          <footer className="work-footer">
            <span>
              {event.brand.name || "EVENTFLOW"} · 活動的每一步，都在這裡。
            </span>
            <span>
              {attendanceOnly
                ? "典禮模式 · 嘉賓、圍枱、簽到與名單匯出"
                : "真實資料 · 正式營運前需完成牌照及場地驗收"}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="page-actions">{action}</div>}
    </div>
  );
}

export function PanelTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-title">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
