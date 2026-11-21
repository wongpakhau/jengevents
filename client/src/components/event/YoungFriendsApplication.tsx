import { useState } from "react";
import {
  ArrowLeft,
  FileCheck2,
  MessageCircle,
  Pencil,
  ShieldCheck,
} from "lucide-react";
import {
  ASSOCIATION_DECLARATIONS,
  PERSONAL_DECLARATIONS,
  INFORMATION_CONSENT,
  YOUNG_FRIENDS_TITLE,
  emptyYoungFriendsApplication,
  hongKongToday,
  isUnder18,
  validateYoungFriendsApplication,
  youngFriendsMessage,
  youngFriendsWhatsAppUrl,
  type ApplicationErrors,
  type YoungFriendsApplication as Application,
} from "@shared/young-friends";

export default function YoungFriendsApplication({
  onClose,
}: {
  onClose: () => void;
}) {
  const [form, setForm] = useState(emptyYoungFriendsApplication);
  const [errors, setErrors] = useState<ApplicationErrors>({});
  const [preview, setPreview] = useState(false);
  const today = hongKongToday();
  function change<K extends keyof Application>(key: K, value: Application[K]) {
    setForm(old => ({ ...old, [key]: value }));
    setErrors(old => ({ ...old, [key]: undefined }));
    setPreview(false);
  }
  function prepare(event: React.FormEvent) {
    event.preventDefault();
    const next = validateYoungFriendsApplication(form, today);
    setErrors(next);
    setPreview(Object.keys(next).length === 0);
  }
  const under18 = isUnder18(form.birthDate, today);
  const valid =
    Object.keys(validateYoungFriendsApplication(form, today)).length === 0;
  const error = (field: keyof Application) =>
    errors[field] && (
      <span id={`yf-error-${field}`} className="yf-field-error">
        {errors[field]}
      </span>
    );
  const attrs = (field: keyof Application) => ({
    "aria-invalid": Boolean(errors[field]),
    "aria-describedby": errors[field] ? `yf-error-${field}` : undefined,
  });
  return (
    <section
      className="event-mobile-card yf-application"
      aria-labelledby="yf-heading"
    >
      <button
        type="button"
        className="event-mobile-text-button"
        onClick={onClose}
      >
        <ArrowLeft size={16} /> 返回快速功能（清除表單）
      </button>
      <div className="yf-heading">
        <span className="yf-symbol">
          <FileCheck2 size={26} />
        </span>
        <div>
          <h2 id="yf-heading">{YOUNG_FRIENDS_TITLE}</h2>
          <p>填寫資料，交由 Mc Jan 跟進申請</p>
        </div>
      </div>
      <p className="yf-privacy-note">
        <ShieldCheck size={17} aria-hidden="true" />
        資料只暫存在此頁；不會另存到 EventFlow。開啟 WhatsApp
        後，請自行確認收件人及傳送。關閉表單將清除未送出的內容。
      </p>
      <form onSubmit={prepare} noValidate>
        <p className="event-mobile-help">
          以下資料均須填寫。申請仍待本會審核；入會介紹人安排請與 Mc Jan 跟進。
        </p>
        <div className="yf-fields">
          <label>
            中文名字
            <input
              value={form.chineseName}
              onChange={e => change("chineseName", e.target.value)}
              required
              maxLength={80}
              autoComplete="off"
              {...attrs("chineseName")}
            />
            {error("chineseName")}
          </label>
          <label>
            英文名字
            <input
              value={form.englishName}
              onChange={e => change("englishName", e.target.value)}
              required
              maxLength={120}
              autoComplete="off"
              {...attrs("englishName")}
            />
            {error("englishName")}
          </label>
          <label>
            性別
            <select
              value={form.gender}
              onChange={e =>
                change("gender", e.target.value as Application["gender"])
              }
              required
              {...attrs("gender")}
            >
              <option value="">請選擇</option>
              <option value="男">男</option>
              <option value="女">女</option>
              <option value="其他">其他</option>
            </select>
            {error("gender")}
          </label>
          <label>
            出生日期
            <input
              type="date"
              value={form.birthDate}
              onChange={e => change("birthDate", e.target.value)}
              min="1900-01-01"
              max={today}
              required
              {...attrs("birthDate")}
            />
            {error("birthDate")}
          </label>
          <label>
            電郵
            <input
              type="email"
              value={form.email}
              onChange={e => change("email", e.target.value)}
              required
              maxLength={254}
              autoComplete="email"
              {...attrs("email")}
            />
            {error("email")}
          </label>
          <label>
            手提電話
            <input
              type="tel"
              value={form.mobile}
              onChange={e => change("mobile", e.target.value)}
              required
              maxLength={25}
              autoComplete="tel"
              placeholder="8位香港電話／海外請加區號"
              {...attrs("mobile")}
            />
            {error("mobile")}
          </label>
          <label className="yf-full">
            住宅地址（具體到門牌號）
            <textarea
              value={form.address}
              onChange={e => change("address", e.target.value)}
              required
              maxLength={500}
              rows={3}
              autoComplete="street-address"
              placeholder="地區、街道、門牌號、大廈、樓層及單位"
              {...attrs("address")}
            />
            {error("address")}
          </label>
        </div>
        <div className="yf-declarations">
          <h3>個人聲明</h3>
          <ol>
            {PERSONAL_DECLARATIONS.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <h3>本會聲明</h3>
          <ol>
            {ASSOCIATION_DECLARATIONS.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <p>{INFORMATION_CONSENT}</p>
        </div>
        <fieldset className="yf-consent">
          <legend>聲明：本人</legend>
          <label className="yf-check">
            <input
              type="checkbox"
              checked={form.declarationsAccepted}
              onChange={e => change("declarationsAccepted", e.target.checked)}
              required
              {...attrs("declarationsAccepted")}
            />
            <span>清楚且同意以上個人聲明、本會聲明及資料使用說明</span>
          </label>
          {error("declarationsAccepted")}
        </fieldset>
        <fieldset className="yf-consent">
          <legend>是否同時登記成為「青聯之友」義工？</legend>
          <div className="yf-radio-row">
            {(["同意", "不同意"] as const).map(value => (
              <label key={value} className="yf-check">
                <input
                  type="radio"
                  name="yf-volunteer"
                  value={value}
                  checked={form.volunteer === value}
                  onChange={() => change("volunteer", value)}
                  required
                  {...attrs("volunteer")}
                />
                <span>{value}</span>
              </label>
            ))}
          </div>
          {error("volunteer")}
        </fieldset>
        {under18 && (
          <fieldset className="yf-consent">
            <legend>未滿18歲的申請者</legend>
            <label className="yf-check">
              <input
                type="checkbox"
                checked={form.guardianConsent}
                onChange={e => change("guardianConsent", e.target.checked)}
                required
                {...attrs("guardianConsent")}
              />
              <span>我已取得家長或監護人同意提出申請</span>
            </label>
            {error("guardianConsent")}
          </fieldset>
        )}
        {Object.values(errors).some(Boolean) && (
          <p className="yf-field-error" role="alert">
            資料尚未完整，請修正上方提示後再預覽。
          </p>
        )}
        {!preview && (
          <button type="submit" className="event-mobile-primary yf-submit">
            <FileCheck2 size={18} /> 預覽 WhatsApp 申請訊息
          </button>
        )}
        {preview && valid && (
          <section
            className="yf-preview"
            aria-label="WhatsApp申請訊息預覽"
            aria-live="polite"
          >
            <h3>確認即將分享的資料</h3>
            <p>收件人：Mc Jan · +852 6112 7981</p>
            <pre>{youngFriendsMessage(form, today)}</pre>
            <p className="event-mobile-help">
              下方按鈕只會開啟 WhatsApp
              並填入訊息，不會自動傳送。完整資料（包括住宅地址及出生日期）會帶入
              WhatsApp 連結，請勿分享此連結。請在 WhatsApp
              核對後自行按「傳送」。
            </p>
            <a
              className="event-mobile-primary yf-submit"
              href={youngFriendsWhatsAppUrl(form, today)}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              <MessageCircle size={18} /> 開啟 WhatsApp，傳給 Mc Jan
            </a>
            <button
              type="button"
              className="event-mobile-text-button"
              onClick={() => setPreview(false)}
            >
              <Pencil size={15} /> 返回修改
            </button>
          </section>
        )}
      </form>
    </section>
  );
}
