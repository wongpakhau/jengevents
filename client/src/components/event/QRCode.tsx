import { useEffect, useState } from "react";
import QR from "qrcode";
export default function QRCode({
  value,
  title = "掃描 QR 碼",
}: {
  value: string;
  title?: string;
}) {
  const [image, setImage] = useState(""),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  const url = value.startsWith("/")
    ? new URL(value, location.origin).href
    : value;
  useEffect(() => {
    let active = true;
    setImage("");
    setError("");
    setCopied(false);
    QR.toDataURL(url, {
      width: 320,
      margin: 3,
      errorCorrectionLevel: "M",
      color: { dark: "#111111", light: "#ffffff" },
    })
      .then(data => {
        if (active) setImage(data);
      })
      .catch(() => {
        if (active) setError("QR 碼未能生成，請使用連結。");
      });
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <div className="mvp-qr">
      <strong>{title}</strong>
      {image ? (
        <img src={image} alt={title} width={260} height={260} />
      ) : (
        <p role="status">{error || "正在產生 QR 碼…"}</p>
      )}
      <div className="mvp-inline-actions">
        <button
          type="button"
          className="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              setError("未能複製；可長按下方連結複製。");
            }
          }}
        >
          {copied ? "已複製" : "複製連結"}
        </button>
        {image && (
          <a className="button" href={image} download="eventflow-qr.png">
            下載 QR
          </a>
        )}
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="button"
        >
          開啟連結
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
