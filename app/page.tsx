"use client";

import { useCallback, useEffect, useState } from "react";

type MetricStatus =
  | "within_range" | "below_range" | "above_range" | "within_target"
  | "below_target" | "above_target" | "range_not_configured" | "unavailable";
type OverallStatus = "stable" | "needs_attention" | "unable_to_assess";
type HistoryPoint = {
  measuredAt: string;
  temperature: number | null;
  moisture: number | null;
  overallStatus: OverallStatus;
};
type Processed = {
  temperature: { value: number | null; unit: "°C"; status: MetricStatus; range: { min: number; max: number } };
  moisture: { value: number | null; unit: "%"; status: MetricStatus; range: { min: number; max: number } | null };
  overallStatus: OverallStatus;
  led: { state: "green" | "yellow" | "red" };
  notes: string[];
};
type Latest = {
  deviceId: string;
  sequence: number;
  measuredAt: string;
  receivedAt: string;
  deviceStatus: "connected" | "stale" | "offline";
  processed: Processed;
};
type ApiResponse = { ok: boolean; latest: Latest | null; history: HistoryPoint[]; error?: string };

const POLL_MS = 2000;

function formatTimestamp(value?: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "Timestamp unavailable";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(value)) + " IST";
}

function statusText(status: MetricStatus) {
  switch (status) {
    case "within_range":
    case "within_target": return "Within reference range";
    case "below_range":
    case "below_target": return "Below reference range";
    case "above_range":
    case "above_target": return "Above reference range";
    case "range_not_configured": return "Target range not configured";
    default: return "Unavailable";
  }
}

function overallText(status?: OverallStatus) {
  if (status === "stable") return "STABLE";
  if (status === "needs_attention") return "NEEDS ATTENTION";
  return "UNABLE TO ASSESS";
}

function makePolyline(values: Array<number | null>) {
  const valid = values.map((value, index) => ({ value, index })).filter(
    (item): item is { value: number; index: number } => item.value !== null && Number.isFinite(item.value)
  );
  if (valid.length < 2) return "";
  const min = Math.min(...valid.map((item) => item.value));
  const max = Math.max(...valid.map((item) => item.value));
  const span = max - min || 1;
  return valid.map(({ value, index }) => {
    const x = 6 + (index / Math.max(values.length - 1, 1)) * 288;
    const y = 68 - ((value - min) / span) * 54;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

export default function Home() {
  const [payload, setPayload] = useState<ApiResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refreshTelemetry = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/telemetry", {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("API request failed");
      const result = await response.json() as ApiResponse;
      if (!result.ok) throw new Error(result.error || "Telemetry unavailable");
      setPayload(result);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshTelemetry();
    const timer = window.setInterval(() => void refreshTelemetry(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshTelemetry]);

  const latest = payload?.latest ?? null;
  const processed = latest?.processed ?? null;
  const history = payload?.history ?? [];
  const deviceStatus = latest?.deviceStatus ?? "offline";
  const visibleDeviceStatus = loadError ? "offline" : deviceStatus;
  const tempValues = history.slice(-30).map((item) => item.temperature);
  const tempPolyline = makePolyline(tempValues);
  const moistureValues = history.slice(-30).map((item) => item.moisture);
  const moisturePolyline = makePolyline(moistureValues);

  const overall = !latest || loadError || deviceStatus !== "connected"
    ? "unable_to_assess"
    : processed?.overallStatus ?? "unable_to_assess";

  const overallMessage = overall === "stable"
    ? "Both measurements are within the configured reference ranges."
    : overall === "needs_attention"
      ? "One or more measurements are outside the configured reference ranges."
      : deviceStatus === "stale" || deviceStatus === "offline"
        ? "No recent readings received. Check the device connection."
        : "A required sensor reading or calibration is unavailable.";

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Smart Bandage home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="M16 5v22M5 16h22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              <rect x="7" y="7" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </span>
          <span className="brand-copy"><strong>Smart Bandage</strong><span>LIVE MONITORING</span></span>
        </a>
        <div className="topbar-actions">
          <span className={`connection-pill connection-${visibleDeviceStatus}`}>
            <span className="tag-dot" />{visibleDeviceStatus === "connected" ? "DEVICE ONLINE" : visibleDeviceStatus === "stale" ? "DATA STALE" : "DEVICE OFFLINE"}
          </span>
          <button className="refresh-button" type="button" onClick={() => void refreshTelemetry()} disabled={refreshing}>
            <svg className={refreshing ? "refresh-icon spinning" : "refresh-icon"} viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M16 8a6.1 6.1 0 0 0-10.9-2L3.5 8M3.5 4.5V8H7M4 12a6.1 6.1 0 0 0 10.9 2l1.6-2M16.5 15.5V12H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg><span>{refreshing ? "Updating" : "Refresh"}</span>
          </button>
        </div>
      </header>

      <div className="page-content">
        <section className="page-heading">
          <div className="eyebrow"><span className="eyebrow-line" />YOUR WELLBEING</div>
          <h1>Smart Bandage<span>.</span></h1>
          <p>Live readings from your connected monitoring device.</p>
        </section>

        {loadError && <div className="notice" role="status">We couldn’t reach the telemetry service. Retrying automatically.</div>}

        <section className={`overall-panel overall-${overall}`} aria-live="polite">
          <div className="overall-left">
            <div className="overall-kicker">OVERALL MONITORING STATUS</div>
            <h2>{overallText(overall)}</h2>
            <p>{overallMessage}</p>
          </div>
          <div className="overall-indicator" aria-hidden="true">
            {overall === "stable" ? "✓" : overall === "needs_attention" ? "!" : "—"}
          </div>
        </section>

        {overall === "needs_attention" && (
          <div className="notice notice-attention" role="alert" aria-live="assertive">
            <span className="notice-mark">!</span>
            <span>One or more measurements are outside the configured reference range. Review the individual readings below.</span>
          </div>
        )}

        {overall === "unable_to_assess" && latest && (
          <div className="notice" role="status">
            <span className="notice-mark">i</span>
            <span>{processed?.notes?.join(" ") || "A required measurement is unavailable or calibration is incomplete."}</span>
          </div>
        )}

        <section className="reading-layout" aria-label="Latest measurements">
          <div className="metric-stack">
            <article className="temperature-card panel">
              <div className="card-topline">
                <div className="metric-overline">LIVE MEASUREMENT</div>
                <span className="data-tag live-tag"><span className="tag-dot" />TEMPERATURE</span>
              </div>
              <div className="temperature-title">Temperature</div>
              <div className="temperature-value">
                <span className="temperature-number">{processed?.temperature.value === null || processed?.temperature.value === undefined ? "—" : processed.temperature.value.toFixed(1)}</span>
                <span className="temperature-unit">°C</span>
              </div>
              <p className="temperature-note">
                {processed ? statusText(processed.temperature.status) : "Waiting for the first sensor reading"}
                {processed && ` · Reference ${processed.temperature.range.min.toFixed(1)}–${processed.temperature.range.max.toFixed(1)}°C`}
              </p>
              <div className="hero-divider" />
              <div className="hero-footer">
                <div className="hero-footer-item"><span className="footer-label">MEASURED AT</span><strong>{formatTimestamp(latest?.measuredAt)}</strong></div>
                <span className="auto-update"><span className="auto-update-dot" />Live updates</span>
              </div>
            </article>

            <article className="temperature-card panel">
              <div className="card-topline">
                <div className="metric-overline">CALIBRATED ESTIMATE</div>
                <span className="data-tag live-tag"><span className="tag-dot" />MOISTURE</span>
              </div>
              <div className="temperature-title">Moisture balance</div>
              <div className="temperature-value">
                <span className={processed?.moisture.value == null ? "temperature-number value-unavailable" : "temperature-number"}>
                  {processed?.moisture.value == null ? "—" : processed.moisture.value.toFixed(1)}
                </span>
                <span className="temperature-unit">{processed?.moisture.value == null ? "" : "%"}</span>
              </div>
              <p className="temperature-note">
                {processed?.moisture.value == null
                  ? "Calibration required — raw electrode measurements are not displayed."
                  : `${statusText(processed.moisture.status)}${processed.moisture.range ? ` · Target ${processed.moisture.range.min}–${processed.moisture.range.max}%` : ""}`}
              </p>
              <div className="hero-divider" />
              <div className="hero-footer">
                <div className="hero-footer-item"><span className="footer-label">MEASURED AT</span><strong>{formatTimestamp(latest?.measuredAt)}</strong></div>
                <span className="auto-update"><span className="auto-update-dot" />Live updates</span>
              </div>
            </article>
          </div>

          <aside className="reading-side" aria-label="Device information">
            <article className="detail-card panel">
              <span className="detail-icon status-icon" aria-hidden="true">⌁</span>
              <span className="detail-label">Device connection</span>
              <strong className="detail-value">{visibleDeviceStatus === "connected" ? "Connected" : visibleDeviceStatus === "stale" ? "Connection unstable" : "Offline"}</strong>
              <span className="detail-caption">{latest ? `Device ID: ${latest.deviceId}` : "Waiting for device data"}</span>
            </article>
            <article className="detail-card panel">
              <span className="detail-icon status-icon" aria-hidden="true">◷</span>
              <span className="detail-label">Last updated</span>
              <strong className="detail-value timestamp-value">{formatTimestamp(latest?.measuredAt)}</strong>
              <span className="detail-caption">{latest ? `Reading sequence #${latest.sequence}` : "No readings received yet"}</span>
            </article>
            <article className="detail-card panel">
              <span className="detail-icon status-icon" aria-hidden="true">↻</span>
              <span className="detail-label">Sensor availability</span>
              <strong className="detail-value">{processed && processed.temperature.status !== "unavailable" ? "Temperature OK" : "Temperature unavailable"}</strong>
              <span className="detail-caption">{processed && processed.moisture.status !== "unavailable" ? "Moisture calibrated" : "Moisture calibration pending"}</span>
            </article>
          </aside>
        </section>

        <section className="history-section panel">
          <div className="history-header">
            <div><div className="metric-overline">RECENT TELEMETRY</div><h2>Reading history</h2></div>
            <span className="history-count">{history.length} samples</span>
          </div>
          {history.length < 2 ? (
            <p className="empty-history">History will appear after the device sends more readings.</p>
          ) : (
            <div className="history-grid">
              <div className="history-chart">
                <div className="history-chart-title">Temperature (°C)</div>
                <svg viewBox="0 0 300 76" role="img" aria-label="Recent temperature trend">
                  <path d="M6 68H294" stroke="#e6ece8" strokeWidth="1" />
                  {tempPolyline && <polyline points={tempPolyline} fill="none" stroke="#17834d" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />}
                </svg>
              </div>
              <div className="history-chart">
                <div className="history-chart-title">Moisture (%)</div>
                <svg viewBox="0 0 300 76" role="img" aria-label="Recent moisture trend">
                  <path d="M6 68H294" stroke="#e6ece8" strokeWidth="1" />
                  {moisturePolyline && <polyline points={moisturePolyline} fill="none" stroke="#2f83b8" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />}
                </svg>
                {!moisturePolyline && <div className="chart-caption">Available after electrode calibration.</div>}
              </div>
            </div>
          )}
          <p className="history-footnote">Historical values are based on received sensor samples. This display is an exhibition prototype, not a medical diagnosis.</p>
        </section>

        <footer className="page-footer">
          <div className="footer-brand"><span className="footer-brand-dot" />SMART BANDAGE</div>
          <p>For demonstration and monitoring education—not medical diagnosis.</p>
        </footer>
      </div>
    </main>
  );
}
