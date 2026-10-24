"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TelemetryData = Record<string, unknown>;
type TelemetryReading = { receivedAt: string; data: TelemetryData };
type TelemetryResponse = { ok: boolean; latest: TelemetryReading | null; error?: string };
type AlertItem = { id: string; title: string; message: string; key: string; severity: "warning" };

// IMPORTANT: These are engineering configuration points, not universal medical thresholds.
// Set moisture limits only after calibrating the actual sensor and validating the dressing.
// Temperature alerts use a relative change from a supplied baseline, not a universal absolute temperature.
const TEMP_DELTA_WARNING_C = 1.5; // Published wound-temperature studies discuss ~1.5–2.2 °C differences, but validation is context-specific.
const MOISTURE_LOW_LIMIT: number | null = null;  // Set after sensor calibration, in the sensor's normalized 0–100 scale.
const MOISTURE_HIGH_LIMIT: number | null = null; // Set after sensor calibration, in the sensor's normalized 0–100 scale.
const ALERT_COOLDOWN_MS = 60_000;

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
function firstNumeric(data: TelemetryData | undefined, keys: string[]): number | null {
  if (!data) return null;
  for (const key of keys) {
    const value = numericValue(data[key]);
    if (value !== null) return value;
  }
  return null;
}
function formatTimestamp(value?: string): string {
  if (!value) return "Waiting for the first reading";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}
function isTestPayload(data?: TelemetryData): boolean {
  return !!data && (data.test === "flightlab" || data.test === "smart-bandage" || data.test === true || data.isTest === true);
}
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  return "—";
}

export default function Home() {
  const [reading, setReading] = useState<TelemetryReading | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [alertHistory, setAlertHistory] = useState<AlertItem[]>([]);
  const lastAlertAt = useRef<Record<string, number>>({});

  const refreshTelemetry = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/telemetry", { method: "GET", cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Unable to refresh readings");
      const result = (await response.json()) as TelemetryResponse;
      if (!result.ok) throw new Error("Unable to refresh readings");
      setReading(result.latest);
      setLoadError(false);
    } catch { setLoadError(true); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    void refreshTelemetry();
    const interval = window.setInterval(() => void refreshTelemetry(), 3000);
    return () => window.clearInterval(interval);
  }, [refreshTelemetry]);

  const data = reading?.data;
  const temperature = firstNumeric(data, ["temperature", "temp", "temperatureC", "temperature_c"]);
  const moisture = firstNumeric(data, ["moisture", "moisturePercent", "moisture_percent", "humidity"]);
  const baselineTemperature = firstNumeric(data, ["baselineTemperature", "baseline_temperature", "referenceTemperature", "reference_temperature"]);
  const sampleNumber = data?.sampleNumber;
  const testPayload = isTestPayload(data);
  const tempDelta = temperature !== null && baselineTemperature !== null ? temperature - baselineTemperature : null;

  const activeAlerts = useMemo<AlertItem[]>(() => {
    if (!data || testPayload) return [];
    const alerts: AlertItem[] = [];
    if (tempDelta !== null && Math.abs(tempDelta) >= TEMP_DELTA_WARNING_C) {
      const direction = tempDelta > 0 ? "higher" : "lower";
      alerts.push({ id: `temperature-${direction}`, key: `temperature-${direction}`, severity: "warning", title: tempDelta > 0 ? "Temperature is elevated" : "Temperature is lower than baseline", message: `The measured temperature is ${Math.abs(tempDelta).toFixed(1)} °C ${direction} than the supplied reference temperature. Check the bandage and follow your clinician’s care instructions.` });
    }
    if (moisture !== null && MOISTURE_LOW_LIMIT !== null && moisture < MOISTURE_LOW_LIMIT) {
      alerts.push({ id: "moisture-low", key: "moisture-low", severity: "warning", title: "Moisture reading is low", message: "The sensor reading is below its calibrated range. Check the dressing and follow your clinician’s care instructions." });
    }
    if (moisture !== null && MOISTURE_HIGH_LIMIT !== null && moisture > MOISTURE_HIGH_LIMIT) {
      alerts.push({ id: "moisture-high", key: "moisture-high", severity: "warning", title: "Moisture reading is high", message: "The sensor reading is above its calibrated range. Excess moisture can affect the surrounding skin; check the dressing and follow your clinician’s care instructions." });
    }
    return alerts;
  }, [data, testPayload, tempDelta, moisture]);

  useEffect(() => {
    if (activeAlerts.length === 0) return;
    const now = Date.now();
    const newAlerts = activeAlerts.filter((alert) => now - (lastAlertAt.current[alert.key] ?? 0) >= ALERT_COOLDOWN_MS);
    if (newAlerts.length === 0) return;
    for (const alert of newAlerts) lastAlertAt.current[alert.key] = now;
    setAlertHistory((previous) => [...newAlerts, ...previous].slice(0, 8));
    setDismissedIds((previous) => previous.filter((id) => !newAlerts.some((alert) => alert.id === id)));
  }, [activeAlerts]);

  const visibleAlerts = alertHistory.filter((alert) => !dismissedIds.includes(alert.id));
  const temperatureOutOfRange = activeAlerts.some((alert) => alert.key.startsWith("temperature-"));
  const moistureOutOfRange = activeAlerts.some((alert) => alert.key.startsWith("moisture-"));
  const conditionLabel = testPayload ? "Demo reading" : activeAlerts.length > 0 ? "Needs attention" : reading ? "No active alerts" : "Awaiting readings";
  const sampleText = sampleNumber === undefined || sampleNumber === null ? "Latest reading" : `Sample #${displayValue(sampleNumber)}`;
  const readingDescription = testPayload ? `${sampleText} · Test data, not a real sensor measurement` : reading ? `${sampleText} · From your Smart Bandage` : "Your latest measurements will appear here";

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Smart Bandage home">
          <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 5v22M5 16h22" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/><rect x="7" y="7" width="18" height="18" rx="5" stroke="currentColor" strokeWidth="1.5"/></svg></span>
          <span className="brand-copy"><strong>Smart Bandage</strong><span>PERSONAL CARE</span></span>
        </a>
        <button className="refresh-button" type="button" onClick={() => void refreshTelemetry()} disabled={refreshing} aria-label="Refresh readings">
          <svg className={refreshing ? "refresh-icon spinning" : "refresh-icon"} viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16 8a6.1 6.1 0 0 0-10.9-2L3.5 8M3.5 4.5V8H7M4 12a6.1 6.1 0 0 0 10.9 2l1.6-2M16.5 15.5V12H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg><span>{refreshing ? "Updating" : "Refresh"}</span>
        </button>
      </header>

      <div className="page-content">
        <section className="page-heading"><div className="eyebrow"><span className="eyebrow-line" />YOUR WELLBEING</div><h1>Your bandage<span>.</span></h1><p>Check your latest readings and any care alerts.</p></section>

        {loadError && <div className="notice" role="status" aria-live="polite"><span className="notice-mark">!</span><span>We couldn’t update your readings just now. We’ll try again automatically.</span></div>}

        {visibleAlerts.length > 0 && <section className="alerts" aria-label="Care alerts" aria-live="polite">
          {visibleAlerts.map((alert) => <article className="alert-card" key={alert.id}>
            <div className="alert-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5 21 20H3L12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M12 9v5M12 17.2v.1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"/></svg></div>
            <div className="alert-copy"><div className="alert-heading">{alert.title}</div><p>{alert.message}</p><span className="alert-footnote">This alert is informational and is not a diagnosis.</span></div>
            <button className="dismiss-button" type="button" onClick={() => setDismissedIds((previous) => [...previous, alert.id])}>Stop Alert</button>
          </article>)}
        </section>}

        <section className="reading-layout" aria-label="Latest measurements">
          <article className={`temperature-card panel ${temperatureOutOfRange ? "metric-alert" : ""}`}>
            <div className="card-topline"><div className="metric-overline">LATEST MEASUREMENT</div>{testPayload ? <span className="data-tag test-tag"><span className="tag-dot"/>TEST DATA</span> : <span className={`data-tag ${temperatureOutOfRange ? "warning-tag" : "live-tag"}`}><span className="tag-dot"/>{temperatureOutOfRange ? "CHECK READING" : reading ? "LATEST READING" : "AWAITING DATA"}</span>}</div>
            <div className="temperature-title">{testPayload ? "Test temperature" : "Temperature"}</div>
            <div className="temperature-value" aria-label={temperature === null ? "No temperature reading yet" : `${temperature.toFixed(1)} degrees Celsius`}><span className="temperature-number">{temperature === null ? "—" : temperature.toFixed(1)}</span><span className="temperature-unit">°C</span></div>
            <p className="temperature-note">{readingDescription}</p>
            <div className="hero-divider"/><div className="hero-footer"><div className="hero-footer-item"><span className="footer-label">LAST UPDATED</span><strong>{formatTimestamp(reading?.receivedAt)}</strong></div><span className="auto-update"><span className="auto-update-dot"/>Updates automatically</span></div>
          </article>

          <aside className="reading-side" aria-label="Other measurements and status">
            <article className={`detail-card panel ${moistureOutOfRange ? "detail-alert" : ""}`}><span className="detail-icon moisture-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3C9.5 7 5.5 10.4 5.5 14.2a6.5 6.5 0 0 0 13 0C18.5 10.4 14.5 7 12 3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M9 15.5c.4 1.2 1.3 1.8 2.5 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg></span><span className="detail-label">Moisture</span><strong className="detail-value">{moisture === null ? "—" : `${moisture.toFixed(1)}${data?.moisturePercent !== undefined || data?.moisture_percent !== undefined ? "%" : ""}`}</strong><span className="detail-caption">{moisture === null ? "Waiting for a moisture sensor" : moistureOutOfRange ? "Outside calibrated range" : "Sensor reading"}</span></article>
            <article className={`detail-card panel status-card ${activeAlerts.length > 0 ? "detail-alert" : ""}`}><span className="detail-icon status-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.7"/><path d="m8.5 12.2 2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span className="detail-label">Current status</span><strong className={`detail-value status-value ${activeAlerts.length > 0 ? "status-warning" : ""}`}>{conditionLabel}</strong><span className="detail-caption">{testPayload ? "Demo data only" : activeAlerts.length > 0 ? "Review the alert above" : reading ? "No configured alerts detected" : "Waiting for readings"}</span></article>
          </aside>
        </section>
        <footer className="page-footer"><div className="footer-brand"><span className="footer-brand-dot"/>SMART BANDAGE</div><p>For monitoring support—not a medical diagnosis.</p></footer>
      </div>
    </main>
  );
}
