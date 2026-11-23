import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { Camera, Keyboard, LoaderCircle, ScanLine, X } from "lucide-react";

type QRScannerProps = {
  onDetect: (value: string) => void | Promise<void>;
  title?: string;
  description?: string;
  manualLabel?: string;
  manualPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  embedded?: boolean;
};

function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "未獲相機權限。請在瀏覽器設定允許相機，或改用下方輸入。";
  }
  if (name === "NotFoundError") {
    return "找不到可用相機。請接上相機，或改用下方輸入。";
  }
  if (name === "NotReadableError") {
    return "相機正被其他程式使用。關閉其他相機程式後再試，或改用下方輸入。";
  }
  return "無法開啟相機。請確認 HTTPS 與相機權限，或改用下方輸入。";
}

/**
 * QR scanning is intentionally opt-in: the camera is only requested after a
 * direct press on the button. The text fallback accepts either a raw token or
 * the complete invitation / receipt link.
 */
export default function QRScanner({
  onDetect,
  title = "掃描 QR code",
  description = "相機只會在你按下開啟後啟動。",
  manualLabel = "沒有相機？貼上完整連結或輸入 token",
  manualPlaceholder = "貼上 QR 的完整連結或 token",
  disabled = false,
  className = "",
  embedded = false,
}: QRScannerProps) {
  const manualInputId = useId();
  const ManualTag = embedded ? "div" : "form";
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserQRCodeReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const detectedRef = useRef(false);
  const onDetectRef = useRef(onDetect);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState("");
  const [submittingManual, setSubmittingManual] = useState(false);

  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  const stopCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;

    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) {
      stream.getTracks().forEach(track => track.stop());
    }
    if (videoRef.current) videoRef.current.srcObject = null;

    readerRef.current = null;
    setCameraOpen(false);
    setStarting(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const reportValue = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setScannerError(null);
    try {
      await onDetectRef.current(trimmed);
    } catch (error) {
      setScannerError(
        error instanceof Error
          ? error.message
          : "未能處理此 QR code，請再試一次。"
      );
    }
  }, []);

  const openCamera = useCallback(async () => {
    if (disabled || starting || cameraOpen) return;

    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setScannerError(
        "相機掃描需要 HTTPS。請改用 HTTPS 網址，或使用下方輸入。"
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setScannerError("此瀏覽器不支援相機掃描，請使用下方輸入。");
      return;
    }

    setScannerError(null);
    setStarting(true);
    detectedRef.current = false;

    try {
      const reader = new BrowserQRCodeReader();
      readerRef.current = reader;
      if (!videoRef.current) throw new Error("相機畫面尚未準備好");

      const controls = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        result => {
          if (!result || detectedRef.current) return;
          detectedRef.current = true;
          const value = result.getText();
          stopCamera();
          void reportValue(value);
        }
      );
      controlsRef.current = controls;
      setCameraOpen(true);
      setStarting(false);
    } catch (error) {
      stopCamera();
      setScannerError(cameraErrorMessage(error));
    }
  }, [cameraOpen, disabled, reportValue, starting, stopCamera]);

  const submitManual = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!manualValue.trim() || disabled || submittingManual) return;
    setSubmittingManual(true);
    await reportValue(manualValue);
    setSubmittingManual(false);
  };

  return (
    <section className={`qr-scanner ${className}`.trim()} aria-label={title}>
      <div className="qr-scanner__heading">
        <span className="qr-scanner__icon">
          <ScanLine size={19} />
        </span>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>

      <div
        className={`qr-scanner__camera ${cameraOpen ? "" : "qr-scanner__camera--hidden"}`.trim()}
      >
        <video ref={videoRef} muted playsInline aria-label="QR code 相機畫面" />
        {cameraOpen && (
          <button
            type="button"
            className="event-mobile-secondary"
            onClick={stopCamera}
          >
            <X size={16} />
            關閉相機
          </button>
        )}
      </div>

      {!cameraOpen && (
        <button
          type="button"
          className="event-mobile-primary"
          onClick={openCamera}
          disabled={disabled || starting}
        >
          {starting ? (
            <LoaderCircle className="event-mobile-spin" size={18} />
          ) : (
            <Camera size={18} />
          )}
          {starting ? "正在開啟相機…" : "開啟相機掃描"}
        </button>
      )}

      {scannerError && (
        <p
          className="event-mobile-alert event-mobile-alert--error"
          role="alert"
        >
          {scannerError}
        </p>
      )}

      <ManualTag className="qr-scanner__manual" onSubmit={submitManual}>
        <label htmlFor={manualInputId}>
          <Keyboard size={15} />
          {manualLabel}
        </label>
        <div>
          <input
            id={manualInputId}
            value={manualValue}
            onChange={event => setManualValue(event.target.value)}
            onKeyDown={event => {
              if (embedded && event.key === "Enter") void submitManual(event);
            }}
            placeholder={manualPlaceholder}
            autoComplete="off"
            disabled={disabled || submittingManual}
          />
          <button
            type={embedded ? "button" : "submit"}
            onClick={embedded ? event => void submitManual(event) : undefined}
            className="event-mobile-secondary"
            disabled={disabled || submittingManual || !manualValue.trim()}
          >
            {submittingManual ? "處理中…" : "確認"}
          </button>
        </div>
      </ManualTag>
    </section>
  );
}
