import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowUpRight,
  ArrowLeft,
  Users,
  Search,
  ScanLine,
  Store,
  Ticket,
  Gift,
  Palette,
  ReceiptText,
  LockKeyhole,
  Smartphone,
  ArrowRight,
  Check,
  Info,
} from "lucide-react";
import {
  PageHeading,
  PanelTitle,
  navigation,
} from "@/components/event/EventShell";
import {
  demoGuests,
  demoTransactions,
  demoEvent,
  money,
} from "@/lib/event-demo";

const sections: Record<
  string,
  {
    title: string;
    en: string;
    desc: string;
    icon: typeof Users;
    steps: string[];
  }
> = {
  "/checkin": {
    title: "現場簽到",
    en: "A WARM WELCOME",
    desc: "嘉賓一掃到場，枱號安排即刻清晰。",
    icon: ScanLine,
    steps: ["掃描嘉賓邀請 QR", "確認身份與枱號", "同步到場狀態"],
  },
  "/merchants": {
    title: "商戶管理",
    en: "CONNECT EVERY MERCHANT",
    desc: "由消費到憑證，把攤檔與嘉賓連在一起。",
    icon: Store,
    steps: ["配置商戶與工作人員", "輸入消費，發出 QR", "查看交易與應收費用"],
  },
  "/settlements": {
    title: "交易與對帳",
    en: "EVERY TRANSACTION, ACCOUNTED FOR",
    desc: "有效收入的10%，清楚記帳，從容對帳。",
    icon: ReceiptText,
    steps: ["有效交易收入", "自動換算10%應收", "記錄已收與餘額"],
  },
  "/draw": {
    title: "抽獎控制",
    en: "MAKE THE MOMENT COUNT",
    desc: "公平結果交給系統，精彩揭曉交給舞台。",
    icon: Gift,
    steps: ["設定獎項與有效參與者", "後端抽選並記錄結果", "同步舞台，懸念揭曉"],
  },
  "/settings": {
    title: "白牌設定",
    en: "YOUR BRAND, YOUR EVENT",
    desc: "同一套可靠流程，換上每場活動的專屬面貌。",
    icon: Palette,
    steps: [
      "設定品牌名稱與主色",
      "配置每筆／跨筆累積",
      "複製活動配置，不複製營運資料",
    ],
  },
};
export default function WorkspaceDraft() {
  const [location] = useLocation();
  const [search, setSearch] = useState("");
  if (location === "/guests")
    return (
      <>
        <PageHeading
          eyebrow="PEOPLE MAKE THE EVENT"
          title="嘉賓管理"
          description="每個名字背後，都有一位重要的嘉賓。"
          action={
            <span className="soft-badge">
              <Users size={15} />
              112 位示範嘉賓
            </span>
          }
        />
        <section className="panel">
          <PanelTitle
            title="嘉賓名單示意"
            subtitle="視覺初稿 · 尚未接通完整名單"
            action={
              <label className="search-box">
                <Search size={15} />
                <input
                  placeholder="搜尋示範嘉賓"
                  aria-label="搜尋示範嘉賓"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </label>
            }
          />
          <div className="guest-list-table">
            <div className="guest-list-head">
              <span>嘉賓</span>
              <span>類別</span>
              <span>枱號</span>
              <span>簽到狀態</span>
            </div>
            {demoGuests
              .filter(
                g =>
                  g.name.includes(search) ||
                  g.en.toLowerCase().includes(search.toLowerCase())
              )
              .map(g => (
                <div className="guest-list-row" key={g.name}>
                  <div className="merchant-cell">
                    <span className="guest-avatar">{g.name[0]}</span>
                    <div>
                      <strong>{g.name}</strong>
                      <small>{g.en}</small>
                    </div>
                  </div>
                  <span>{g.type}</span>
                  <strong>{g.table} 號枱</strong>
                  <span
                    className={`status-pill ${g.arrived ? "success" : "neutral"}`}
                  >
                    {g.arrived ? "已到場" : "未到場"}
                  </span>
                </div>
              ))}
            {!demoGuests.some(
              g =>
                g.name.includes(search) ||
                g.en.toLowerCase().includes(search.toLowerCase())
            ) && <p className="empty-search">沒有符合的示範嘉賓</p>}
          </div>
        </section>
        <div className="demo-note">
          <Info size={15} />
          搜尋只篩選畫面上的5位示範嘉賓，並非正式嘉賓資料庫。
        </div>
      </>
    );
  const data = sections[location] ?? sections["/settings"];
  return (
    <>
      <PageHeading
        eyebrow={data.en}
        title={data.title}
        description={data.desc}
      />
      <div className="draft-intro panel">
        <div className="draft-icon">
          <data.icon size={30} strokeWidth={1.4} />
        </div>
        <div>
          <span className="eyebrow">WORKSPACE PREVIEW</span>
          <h2>流程已規劃，功能待接通。</h2>
          <p>
            這是第一版工作區骨架。視覺確認後，會接通真實身份、資料庫與操作紀錄。
          </p>
        </div>
        <span className="status-pill pending">v0 初稿</span>
      </div>
      <div className="flow-steps">
        {data.steps.map((s, i) => (
          <section className="panel flow-step" key={s}>
            <span className="flow-number">0{i + 1}</span>
            <h3>{s}</h3>
            <p>在完整 MVP 中接通</p>
            {i < 2 && <ArrowRight size={20} />}
          </section>
        ))}
      </div>
      {location === "/draw" && (
        <section className="panel draft-preview-action">
          <div>
            <h2>先看看舞台的樣子。</h2>
            <p>
              保留簡單三軸捲動，減速停定後顯示嘉賓姓名與枱號。預覽不會執行正式抽獎。
            </p>
          </div>
          <Link href="/screen" className="button button-dark">
            開啟舞台預覽
            <ArrowUpRight size={16} />
          </Link>
        </section>
      )}
      {location === "/merchants" && (
        <section className="panel draft-preview-action">
          <div>
            <h2>結帳只需輸入金額。</h2>
            <p>HK$2,500 → 2次機會 → HK$250 大會應收抽獎費。</p>
          </div>
          <Link href="/merchant" className="button button-dark">
            商戶端預覽
            <ArrowUpRight size={16} />
          </Link>
        </section>
      )}
      {location === "/checkin" && (
        <section className="panel draft-preview-action">
          <div>
            <h2>到場的第一步，簡單一點。</h2>
            <p>嘉賓QR簽到區及手機枱號顯示會在完整 MVP 接通。</p>
          </div>
          <Link href="/guest" className="button button-dark">
            嘉賓端預覽
            <ArrowUpRight size={16} />
          </Link>
        </section>
      )}
      {location === "/settings" && (
        <section className="panel brand-draft">
          <PanelTitle
            title="品牌外觀示意"
            subtitle="以下為初稿品牌，尚未提供儲存或複製。"
          />
          <div className="brand-draft-body">
            <img src="/eventflow-mark.svg" alt="EventFlow 品牌標誌" />
            <div>
              <strong>EventFlow</strong>
              <p>石墨黑 · 暖白 · 琥珀金</p>
            </div>
            <div className="color-swatches">
              <span style={{ background: "#202321" }} />
              <span style={{ background: "#F7F8F4" }} />
              <span style={{ background: "#C89538" }} />
            </div>
          </div>
        </section>
      )}
      {location === "/settlements" && (
        <section className="panel">
          <PanelTitle
            title="10%抽獎費示意"
            subtitle="以有效交易收入計算，不以已領取憑證計算。"
          />
          <div className="settlement-preview">
            {demoTransactions.map(t => (
              <div key={t.id}>
                <span>{t.merchant}</span>
                <strong>HK${money(t.amount)}</strong>
                <ArrowRight size={16} />
                <span className="text-gold">
                  HK${money(t.amount * 0.1)} 應收
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="demo-note">
        <LockKeyhole size={15} />
        正式資料寫入與角色權限待接通；本頁不執行收款、簽到或抽獎。
      </div>
    </>
  );
}
export function MerchantDraft() {
  const [amount, setAmount] = useState("2500");
  const value = Math.max(0, Number(amount) || 0);
  const chances = Math.floor(value / 1000);
  return (
    <div className="mobile-preview">
      <div className="mobile-preview-nav">
        <Link href="/">
          <ArrowLeft size={16} />
          返回工作台
        </Link>
        <span>商戶端 · 視覺初稿</span>
      </div>
      <div className="phone-card">
        <div className="merchant-phone-head">
          <img src="/eventflow-mark.svg" alt="" />
          <span>
            eventflow <small>MERCHANT</small>
          </span>
          <span className="status-pill success">示範商戶</span>
        </div>
        <div className="phone-body">
          <span className="eyebrow">匠心茶舍 · 示範攤檔</span>
          <h1>記錄這筆消費。</h1>
          <p>輸入金額，下一個驚喜就從這裡開始。</p>
          <label className="amount-input-label" htmlFor="amount">
            本筆消費金額
          </label>
          <div className="amount-input">
            <span>HK$</span>
            <input
              id="amount"
              type="number"
              min="0"
              step="1"
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
          </div>
          <div className="amount-presets">
            {["1000", "2300", "2500"].map(v => (
              <button key={v} onClick={() => setAmount(v)}>
                ${money(Number(v))}
              </button>
            ))}
          </div>
          <div className="merchant-preview-result">
            <div>
              <span>本筆抽獎機會</span>
              <strong>
                {chances}
                <small> 次</small>
              </strong>
            </div>
            <Ticket size={28} />
          </div>
          <div className="merchant-fee">
            <span>大會抽獎費 · 10%</span>
            <strong>HK${money(value * 0.1)}</strong>
          </div>
          <button className="button button-dark button-full" disabled>
            <ScanLine size={17} />
            憑證 QR 將於 MVP 接通
          </button>
          <p className="phone-disclaimer">
            <Info size={14} />
            目前金額只作版面計算，不建立交易或憑證。
          </p>
        </div>
      </div>
    </div>
  );
}
export function GuestDraft() {
  return (
    <div className="mobile-preview">
      <div className="mobile-preview-nav">
        <Link href="/">
          <ArrowLeft size={16} />
          返回工作台
        </Link>
        <span>嘉賓端 · 視覺初稿</span>
      </div>
      <div className="phone-card guest-phone">
        <div className="guest-phone-head">
          <div className="guest-phone-brand">
            <img src="/eventflow-mark.svg" alt="" />
            <span>EVENTFLOW</span>
          </div>
          <span className="mini-label">HONG KONG BUSINESS GALA</span>
          <h1>今晚，由你閃耀。</h1>
          <p>{demoEvent.name}</p>
        </div>
        <div className="phone-body">
          <div className="guest-greeting">
            <span>你好，陳嘉欣</span>
            <span className="status-pill success">
              <Check size={12} />
              簽到狀態示意
            </span>
          </div>
          <div className="guest-ticket">
            <div>
              <span>你的枱號</span>
              <strong>
                01<small> 號枱</small>
              </strong>
              <p>VIP 嘉賓 · 座位 03</p>
            </div>
            <ArmchairIcon />
            <span className="ticket-separator" />
            <div className="ticket-meta">
              <span>{demoEvent.date}</span>
              <span>18:00 入場</span>
            </div>
          </div>
          <div className="guest-chances">
            <div>
              <span>累積抽獎機會示意</span>
              <strong>
                3<small> 次</small>
              </strong>
            </div>
            <Ticket size={34} />
          </div>
          <div className="guest-steps">
            <h3>讓每筆消費，多一份期待。</h3>
            <div>
              <span>1</span>
              <p>在商戶攤檔消費</p>
            </div>
            <div>
              <span>2</span>
              <p>掃描商戶消費憑證 QR</p>
            </div>
            <div>
              <span>3</span>
              <p>每滿 HK$1,000，累積1次機會</p>
            </div>
          </div>
          <button className="button button-dark button-full" disabled>
            <ScanLine size={17} />
            掃碼領取 · 待接通
          </button>
          <p className="phone-disclaimer">
            <Info size={14} />
            姓名、枱號及機會均為示範，不代表真實身份。
          </p>
        </div>
      </div>
    </div>
  );
}
function ArmchairIcon() {
  return (
    <div className="ticket-table-icon">
      <Users size={30} strokeWidth={1.4} />
    </div>
  );
}
