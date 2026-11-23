import { useCallback, useEffect, useRef, useState } from "react";
import QRCodeLibrary from "qrcode";
import { Link } from "wouter";
import {
  ArrowLeft,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Store,
  Ticket,
  UserRound,
} from "lucide-react";
import QRScanner from "@/components/event/QRScanner";
import {
  applyRoleDemoAction,
  createRoleDemoState,
  DEMO_CHECKED_IN_PRIZE_CENTS,
  DEMO_GUEST,
  DEMO_GUEST_QR,
  DEMO_MERCHANT,
  getDemoSummary,
  isDemoGuestCode,
  parseDemoAmountCents,
  parseRoleDemoState,
  ROLE_DEMO_STORAGE_KEY,
  serializeRoleDemoState,
  type DemoReceipt,
  type DemoRole,
  type RoleDemoAction,
  type RoleDemoState,
} from "@/lib/role-demo";
import "@/styles/role-demo.css";

export type RoleDemoProps = { role: DemoRole };
type DemoCommit = (action: RoleDemoAction, message: string) => Promise<boolean>;
const roles = [
  { role: "admin", label: "測試管理員", icon: ShieldCheck },
  { role: "merchant", label: "測試商戶", icon: Store },
  { role: "guest", label: "測試用家", icon: UserRound },
] as const;
const statusLabels = {
  pending: "待用家確認",
  confirmed: "已確認",
  rejected: "已拒絕",
};
const currency = new Intl.NumberFormat("en-HK", {
  style: "currency",
  currency: "HKD",
  minimumFractionDigits: 2,
});
const money = (cents: number) => currency.format(cents / 100);
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "無法讀寫本機示範資料，請檢查瀏覽器儲存設定。";
}
function readDemoState(): RoleDemoState {
  return parseRoleDemoState(window.localStorage.getItem(ROLE_DEMO_STORAGE_KEY));
}

/** Only this isolated key is ever read/written. No session, cookies, API or DB access. */
function useDemoState(role: DemoRole) {
  const [snapshot, setSnapshot] = useState(() => {
    if (typeof window === "undefined")
      return { state: createRoleDemoState(), storageError: "" };
    try {
      return { state: readDemoState(), storageError: "" };
    } catch (error) {
      return { state: createRoleDemoState(), storageError: errorText(error) };
    }
  });
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const refresh = useCallback(() => {
    try {
      setSnapshot({ state: readDemoState(), storageError: "" });
    } catch (error) {
      setSnapshot(previous => ({
        ...previous,
        storageError: errorText(error),
      }));
    }
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ROLE_DEMO_STORAGE_KEY || event.key === null) refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(ROLE_DEMO_STORAGE_KEY, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    refresh();
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ROLE_DEMO_STORAGE_KEY, refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    setNotice(null);
  }, [role]);

  const commit: DemoCommit = async (action, message) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    const update = () => {
      // Read again at mutation time so stale UI cannot confirm a receipt twice.
      const raw = window.localStorage.getItem(ROLE_DEMO_STORAGE_KEY);
      let latest: RoleDemoState;
      try {
        latest = parseRoleDemoState(raw);
      } catch (error) {
        if (action.type !== "reset") throw error;
        latest = createRoleDemoState();
      }
      const next = applyRoleDemoAction(latest, role, action);
      window.localStorage.setItem(
        ROLE_DEMO_STORAGE_KEY,
        serializeRoleDemoState(next)
      );
      setSnapshot({ state: next, storageError: "" });
      window.dispatchEvent(new Event(ROLE_DEMO_STORAGE_KEY));
    };
    try {
      // Web Locks serialize cooperating demo tabs where supported. Fallback reads latest.
      if (navigator.locks?.request)
        await navigator.locks.request(ROLE_DEMO_STORAGE_KEY, update);
      else update();
      setNotice({ kind: "success", text: message });
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
      refresh();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { ...snapshot, notice, busy, refresh, commit };
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="role-demo__stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function DemoQR() {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    QRCodeLibrary.toDataURL(DEMO_GUEST_QR, {
      width: 320,
      margin: 3,
      errorCorrectionLevel: "M",
    })
      .then(src => {
        if (active) setImage(src);
      })
      .catch(() => {
        if (active) setError("未能生成示範 QR，請複製下方示範文字。");
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="role-demo__qr">
      <span className="role-demo__tag">DEMO QR · 非正式憑證</span>
      {image ? (
        <img
          src={image}
          width={260}
          height={260}
          alt="示範用家的 DEMO QR，只適用於示範商戶頁"
        />
      ) : (
        <p role="status">{error || "正在產生 DEMO QR…"}</p>
      )}
      <code>{DEMO_GUEST_QR}</code>
      <button
        className="role-demo__button role-demo__button--secondary"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(DEMO_GUEST_QR);
            setCopied(true);
            setError("");
          } catch {
            setError("無法複製，可選取上方示範文字後手動複製。");
          }
        }}
      >
        {copied ? "已複製 DEMO 文字" : "複製 DEMO 文字"}
      </button>
      {copied && (
        <span className="role-demo__muted" role="status">
          示範文字已複製，可到測試商戶頁貼上。
        </span>
      )}
      {error && (
        <p role="alert" className="role-demo__error">
          {error}
        </p>
      )}
    </div>
  );
}

function ReceiptList({
  receipts,
  onDecision,
  busy = false,
}: {
  receipts: DemoReceipt[];
  onDecision?: (receiptId: string, decision: "confirm" | "reject") => void;
  busy?: boolean;
}) {
  if (!receipts.length)
    return (
      <div className="role-demo__empty">
        <ScanLine size={25} aria-hidden="true" />
        <p>尚未有示範交易</p>
        <span>在測試商戶頁提交一筆消費，再到測試用家頁確認。</span>
      </div>
    );
  return (
    <ul className="role-demo__receipts">
      {[...receipts].reverse().map(receipt => (
        <li key={receipt.id}>
          <div className="role-demo__receipt-top">
            <strong>{money(receipt.amountCents)}</strong>
            <span
              className={`role-demo__status role-demo__status--${receipt.status}`}
            >
              {statusLabels[receipt.status]}
            </span>
          </div>
          <dl className="role-demo__receipt-details">
            <div>
              <dt>商戶</dt>
              <dd>{DEMO_MERCHANT.name}</dd>
            </div>
            <div>
              <dt>用家</dt>
              <dd>{DEMO_GUEST.name}</dd>
            </div>
            <div>
              <dt>參考編號</dt>
              <dd>{receipt.reference}</dd>
            </div>
            <div>
              <dt>示範交易</dt>
              <dd>{receipt.id}</dd>
            </div>
            <div>
              <dt>建立時間</dt>
              <dd>
                {new Intl.DateTimeFormat("zh-HK", {
                  dateStyle: "short",
                  timeStyle: "short",
                  timeZone: "Asia/Hong_Kong",
                }).format(new Date(receipt.createdAt))}
                （香港）
              </dd>
            </div>
          </dl>
          {onDecision && receipt.status === "pending" && (
            <div className="role-demo__decision">
              <p>
                核對商戶、金額及參考編號後作出決定；確認後不能重複累計或改為拒絕。
              </p>
              <div className="role-demo__actions">
                <button
                  type="button"
                  className="role-demo__button"
                  disabled={busy}
                  onClick={() => onDecision(receipt.id, "confirm")}
                  aria-label={`確認參考 ${receipt.reference}，金額 ${money(receipt.amountCents)} 的示範消費`}
                >
                  確認此筆消費
                </button>
                <button
                  type="button"
                  className="role-demo__button role-demo__button--danger"
                  disabled={busy}
                  onClick={() => onDecision(receipt.id, "reject")}
                  aria-label={`拒絕參考 ${receipt.reference} 的示範消費`}
                >
                  拒絕此筆消費
                </button>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function FixedPrize() {
  return (
    <section
      className="role-demo__card role-demo__prize"
      aria-labelledby="demo-fixed-prize"
    >
      <Ticket size={24} aria-hidden="true" />
      <div>
        <h2 id="demo-fixed-prize">
          獨立簽到獎 · {money(DEMO_CHECKED_IN_PRIZE_CENTS)}
        </h2>
        <p>
          {DEMO_GUEST.name}的示範簽到狀態：已簽到，固定 <strong>1 次</strong>
          參加機會。不隨消費、確認或拒絕交易增加。
        </p>
        <p className="role-demo__muted">
          只解說規則：不執行真實或隨機抽獎，不發獎、不付款。
        </p>
      </div>
    </section>
  );
}

function GuestDemo({
  state,
  commit,
  busy,
}: {
  state: RoleDemoState;
  commit: DemoCommit;
  busy: boolean;
}) {
  const summary = getDemoSummary(state);
  const ownReceipts = state.receipts.filter(
    receipt => receipt.guestId === DEMO_GUEST.id
  );
  const pending = ownReceipts.filter(receipt => receipt.status === "pending");
  return (
    <>
      <section
        className="role-demo__card role-demo__wide"
        aria-labelledby="demo-guest-spend"
      >
        <div className="role-demo__section-heading">
          <div>
            <span className="role-demo__eyebrow">PERSONAL DEMO WALLET</span>
            <h2 id="demo-guest-spend">{DEMO_GUEST.name}的消費紀錄</h2>
          </div>
          <UserRound aria-hidden="true" />
        </div>
        <div className="role-demo__stats">
          <Stat
            label="個人已確認消費"
            value={money(summary.confirmedSpendCents)}
            detail="待確認及拒絕交易不計算"
          />
          <Stat
            label="消費抽獎機會"
            value={`${summary.spendChances} 次`}
            detail="⌊已確認消費 ÷ HK$500⌋"
          />
          <Stat
            label="累積餘額"
            value={money(summary.remainderCents)}
            detail={`再確認 ${money(summary.untilNextChanceCents)} 可多 1 次`}
          />
        </div>
        <p className="role-demo__muted">
          HK$499 → 0 次；HK$500 → 1 次；HK$1,000 → 2 次。已確認的 HK$300 +
          HK$200 可合計 1 次。
        </p>
      </section>
      <section className="role-demo__card" aria-labelledby="demo-guest-qr">
        <h2 id="demo-guest-qr">我的 DEMO QR</h2>
        <p className="role-demo__muted">
          只供示範商戶識別，並非邀請、簽到或付款 token。
        </p>
        <DemoQR />
      </section>
      <section className="role-demo__card" aria-labelledby="demo-guest-pending">
        <h2 id="demo-guest-pending">
          請確認消費 <span className="role-demo__count">{pending.length}</span>
        </h2>
        <p className="role-demo__muted">
          商戶提交不會直接產生抽獎機會；由你明確確認或拒絕。
        </p>
        <ReceiptList
          receipts={pending}
          busy={busy}
          onDecision={(receiptId, type) => {
            void commit(
              { type, receiptId, at: new Date().toISOString() },
              type === "confirm"
                ? "示範消費已確認，累計已更新。"
                : "示範消費已拒絕，不累計金額或消費抽獎機會。"
            );
          }}
        />
      </section>
      <div className="role-demo__wide">
        <FixedPrize />
      </div>
      <section
        className="role-demo__card role-demo__wide"
        aria-labelledby="demo-guest-history"
      >
        <h2 id="demo-guest-history">已處理的示範交易</h2>
        <ReceiptList
          receipts={ownReceipts.filter(receipt => receipt.status !== "pending")}
        />
      </section>
    </>
  );
}

function MerchantDemo({
  state,
  commit,
  busy,
}: {
  state: RoleDemoState;
  commit: DemoCommit;
  busy: boolean;
}) {
  const [guestCode, setGuestCode] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [validationError, setValidationError] = useState("");
  const verified = isDemoGuestCode(guestCode);
  const amountCents = parseDemoAmountCents(amount);
  const summary = getDemoSummary(state);
  const ownReceipts = state.receipts.filter(
    receipt => receipt.merchantId === DEMO_MERCHANT.id
  );
  return (
    <>
      <section
        className="role-demo__card role-demo__wide"
        aria-labelledby="demo-merchant-summary"
      >
        <span className="role-demo__eyebrow">DEMO MERCHANT TERMINAL</span>
        <h2 id="demo-merchant-summary">{DEMO_MERCHANT.name}</h2>
        <div className="role-demo__stats">
          <Stat label="已確認銷售" value={money(summary.confirmedSpendCents)} />
          <Stat label="待用家確認" value={`${summary.pendingCount} 筆`} />
          <Stat label="已拒絕" value={`${summary.rejectedCount} 筆`} />
        </div>
        <p className="role-demo__muted">
          只能建立示範交易及查看此示範商戶的紀錄，不能代用家確認，不能付款或操作正式資料。
        </p>
      </section>
      <section className="role-demo__card" aria-labelledby="demo-merchant-scan">
        <h2 id="demo-merchant-scan">01 / 識別示範用家</h2>
        <QRScanner
          title="掃描 DEMO QR"
          description="只接受示範用家代碼；相機由你按下按鈕後才啟動。"
          manualLabel="沒有相機？貼上 DEMO 文字"
          manualPlaceholder={DEMO_GUEST_QR}
          disabled={busy}
          onDetect={value => {
            setGuestCode("");
            setValidationError("");
            if (!isDemoGuestCode(value))
              throw new Error(
                "只接受 eventflow-demo:guest:demo-guest；正式 QR 或其他代碼不可使用。"
              );
            setGuestCode(value);
          }}
        />
        {verified && (
          <p className="role-demo__verified" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            已識別：{DEMO_GUEST.name}（DEMO）
          </p>
        )}
        <details className="role-demo__hint">
          <summary>查看可貼上的示範文字</summary>
          <code>{DEMO_GUEST_QR}</code>
        </details>
      </section>
      <section
        className="role-demo__card"
        aria-labelledby="demo-merchant-submit"
      >
        <h2 id="demo-merchant-submit">02 / 建立待確認消費</h2>
        <p className="role-demo__muted">
          先掃描或貼上並確認 DEMO QR，再填寫金額及唯一參考編號。
        </p>
        <form
          className="role-demo__form"
          onSubmit={async event => {
            event.preventDefault();
            setValidationError("");
            if (!verified) {
              setValidationError(
                "請先在左方或上方掃描器確認示範用家 DEMO QR。"
              );
              return;
            }
            const success = await commit(
              {
                type: "submit",
                guestCode,
                amount,
                reference,
                at: new Date().toISOString(),
              },
              "已建立待確認示範交易；到測試用家頁確認後才累計消費。"
            );
            if (success) {
              setAmount("");
              setReference("");
            }
          }}
        >
          <label htmlFor="demo-amount">消費金額（HK$）</label>
          <input
            id="demo-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="例如 300.00"
            value={amount}
            required
            disabled={busy}
            aria-describedby="demo-amount-help"
            onChange={event => setAmount(event.target.value)}
          />
          <small id="demo-amount-help">
            大於 0、最多兩位小數；只儲存整數分。
            {amountCents !== null && `目前：${money(amountCents)}`}
          </small>
          <label htmlFor="demo-reference">商戶交易參考編號</label>
          <input
            id="demo-reference"
            autoComplete="off"
            placeholder="例如 DEMO-001"
            value={reference}
            maxLength={80}
            required
            disabled={busy}
            aria-describedby="demo-reference-help"
            onChange={event => setReference(event.target.value)}
          />
          <small id="demo-reference-help">
            必填且不可重複（不分英文大小寫），即使交易已拒絕亦不可重用。
          </small>
          {validationError && (
            <p className="role-demo__error" role="alert">
              {validationError}
            </p>
          )}
          <button
            className="role-demo__button"
            type="submit"
            disabled={
              busy || !verified || amountCents === null || !reference.trim()
            }
          >
            {busy ? "正在儲存示範交易…" : "建立待確認示範交易"}
          </button>
          {!verified && (
            <p className="role-demo__muted">
              尚未確認有效 DEMO QR，提交按鈕暫不可用。
            </p>
          )}
          <p className="role-demo__note">
            此步驟不增加消費抽獎機會，也不扣款。必須由示範用家確認。
          </p>
        </form>
      </section>
      <section
        className="role-demo__card role-demo__wide"
        aria-labelledby="demo-merchant-receipts"
      >
        <h2 id="demo-merchant-receipts">我的示範交易</h2>
        <p className="role-demo__muted">
          待確認、已確認及已拒絕均保留紀錄；用家處理後會在同一瀏覽器的分頁更新。
        </p>
        <ReceiptList receipts={ownReceipts} />
      </section>
    </>
  );
}

function AdminDemo({
  state,
  commit,
  busy,
}: {
  state: RoleDemoState;
  commit: DemoCommit;
  busy: boolean;
}) {
  const summary = getDemoSummary(state);
  return (
    <>
      <section
        className="role-demo__card role-demo__wide"
        aria-labelledby="demo-admin-overview"
      >
        <span className="role-demo__eyebrow">DEMO CONTROL ROOM</span>
        <h2 id="demo-admin-overview">示範管理總覽</h2>
        <div className="role-demo__stats">
          <Stat
            label="已確認銷售額"
            value={money(summary.confirmedSpendCents)}
          />
          <Stat
            label="示範商戶 10% 應繳"
            value={money(summary.manualDueCents)}
            detail="純示範・人手結算，沒有付款功能"
          />
          <Stat
            label="消費抽獎機會"
            value={`${summary.spendChances} 次`}
            detail={`餘額 ${money(summary.remainderCents)}`}
          />
        </div>
        <p className="role-demo__note">
          10%
          僅按已確認銷售總額計算，四捨五入至分。這是示範的人工應繳數字，不會產生帳單、支付連結、扣款或正式財務紀錄。
        </p>
      </section>
      <section className="role-demo__card" aria-labelledby="demo-admin-guests">
        <h2 id="demo-admin-guests">示範用家名單</h2>
        <div className="role-demo__fixture">
          <span className="role-demo__avatar">
            <UserRound aria-hidden="true" />
          </span>
          <div>
            <strong>{DEMO_GUEST.name}</strong>
            <p>DEMO · 已簽到 · 獨立簽到獎 1 次機會</p>
          </div>
        </div>
        <dl className="role-demo__receipt-details">
          <div>
            <dt>已確認消費</dt>
            <dd>{money(summary.confirmedSpendCents)}</dd>
          </div>
          <div>
            <dt>消費抽獎機會</dt>
            <dd>{summary.spendChances} 次</dd>
          </div>
          <div>
            <dt>固定示範商戶</dt>
            <dd>{DEMO_MERCHANT.name}</dd>
          </div>
        </dl>
        <p className="role-demo__muted">
          只有這個獨立示範用家，不載入活動、真實賓客或正式商戶。
        </p>
      </section>
      <section className="role-demo__card" aria-labelledby="demo-admin-flow">
        <h2 id="demo-admin-flow">三個角色，一個示範流程</h2>
        <ol className="role-demo__steps">
          <li>測試商戶：掃描 DEMO QR，提交金額及參考編號。</li>
          <li>測試用家：核對並確認或拒絕待處理交易。</li>
          <li>測試管理員：查看已確認銷售、10% 人手應繳及消費機會。</li>
        </ol>
        <p className="role-demo__muted">
          待確認 {summary.pendingCount} 筆 · 已確認 {summary.confirmedCount} 筆
          · 已拒絕 {summary.rejectedCount} 筆
        </p>
        <p className="role-demo__muted">
          管理員只查看及重設示範，不可代商戶提交或代用家確認。
        </p>
      </section>
      <div className="role-demo__wide">
        <FixedPrize />
      </div>
      <section
        className="role-demo__card role-demo__wide"
        aria-labelledby="demo-admin-transactions"
      >
        <h2 id="demo-admin-transactions">全部示範交易</h2>
        <ReceiptList receipts={state.receipts} />
      </section>
      <section
        className="role-demo__card role-demo__wide role-demo__reset"
        aria-labelledby="demo-admin-reset"
      >
        <div>
          <h2 id="demo-admin-reset">重設本機示範</h2>
          <p>
            只清除這個示範的交易；恢復已簽到的示範用家及單一簽到機會。不影響正式資料。
          </p>
        </div>
        <button
          className="role-demo__button role-demo__button--danger"
          type="button"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "重設此瀏覽器的全部示範交易？所有 DEMO 角色會同步重設；正式活動及真實資料不受影響。"
              )
            ) {
              void commit(
                { type: "reset" },
                "本機示範已重設，正式資料沒有變更。"
              );
            }
          }}
        >
          重設示範資料
        </button>
      </section>
    </>
  );
}

/** Standalone routes: /demo/admin, /demo/merchant, /demo/guest. Not a login bypass. */
export default function RoleDemo({ role }: RoleDemoProps) {
  const { state, storageError, notice, busy, refresh, commit } =
    useDemoState(role);
  const roleLabel = roles.find(item => item.role === role)?.label ?? "示範角色";
  return (
    <main className={`role-demo role-demo--${role}`}>
      <div className="role-demo__container">
        <div className="role-demo__topline">
          <Link href="/" className="role-demo__leave">
            <ArrowLeft size={17} aria-hidden="true" />
            離開示範，返回首頁
          </Link>
          <span className="role-demo__wordmark">
            EVENTFLOW <b>DEMO</b>
          </span>
        </div>
        <aside className="role-demo__banner" aria-label="示範模式重要說明">
          <FlaskConical size={22} aria-hidden="true" />
          <div>
            <strong>獨立前端示範 · 不是正式登入</strong>
            <p>
              全部為 DEMO
              資料；角色權限只作示範，不代表正式授權。不讀寫正式資料、不使用真實
              QR、不付款。
            </p>
            <p>
              僅存於此瀏覽器的 <code>{ROLE_DEMO_STORAGE_KEY}</code>
              ，相同網站的三個示範角色共用；不跨裝置同步。
            </p>
          </div>
        </aside>
        <header className="role-demo__header">
          <div>
            <span className="role-demo__eyebrow">
              ROLE PLAYGROUND / 本機示範
            </span>
            <h1>{roleLabel}</h1>
            <p>用三個角色走一遍：提交 → 確認 → 查看累計。</p>
          </div>
          <button
            type="button"
            className="role-demo__button role-demo__button--secondary"
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw size={16} aria-hidden="true" />
            重新讀取示範
          </button>
        </header>
        <nav className="role-demo__roles" aria-label="切換示範角色">
          {roles.map(item => (
            <Link
              key={item.role}
              href={`/demo/${item.role}`}
              className={`role-demo__role ${item.role === role ? "role-demo__role--active" : ""}`}
              aria-current={item.role === role ? "page" : undefined}
            >
              <item.icon size={19} aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        {storageError && (
          <div
            className="role-demo__alert role-demo__alert--error"
            role="alert"
          >
            <strong>本機示範儲存不可用</strong>
            <p>{storageError}</p>
            <p>
              以下可能是上次讀取或空白的示範資料。請檢查瀏覽器儲存設定；格式損壞可由測試管理員重設。儲存失敗不會提交交易。
            </p>
          </div>
        )}
        {notice && (
          <div
            className={`role-demo__alert role-demo__alert--${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.text}
          </div>
        )}
        <div className="role-demo__layout" aria-busy={busy}>
          {role === "guest" && (
            <GuestDemo state={state} commit={commit} busy={busy} />
          )}
          {role === "merchant" && (
            <MerchantDemo state={state} commit={commit} busy={busy} />
          )}
          {role === "admin" && (
            <AdminDemo state={state} commit={commit} busy={busy} />
          )}
        </div>
        <footer className="role-demo__footer">
          DEMO ONLY ·
          重設及角色切換均不會登入或登出正式帳戶。跨分頁儲存事件、返回分頁及重新整理時會讀取最新本機示範。
          <Link href="/">返回正式入口</Link>
        </footer>
      </div>
    </main>
  );
}
