export type SensorStatus = "ok" | "disconnected" | "error" | "warming_up";
export type OverallStatus = "stable" | "needs_attention" | "unable_to_assess";
export type LedState = "green" | "red" | "yellow";

export type IncomingTelemetry = {
  schemaVersion: 1;
  deviceId: string;
  timestamp: string;
  sequence: number;
  sensors: {
    temperature: { value: number | null; unit: "degC"; status: SensorStatus };
    capacitance: {
      cin1: number | null;
      cin2: number | null;
      cin3: number | null;
      unit: "pF";
      status: SensorStatus;
    };
  };
};

export type ProcessedTelemetry = {
  temperature: {
    value: number | null;
    unit: "°C";
    status: "within_range" | "below_range" | "above_range" | "unavailable";
    range: { min: number; max: number };
  };
  moisture: {
    value: number | null;
    unit: "%";
    status: "within_target" | "below_target" | "above_target" | "range_not_configured" | "unavailable";
    range: { min: number; max: number } | null;
  };
  overallStatus: OverallStatus;
  led: { state: LedState };
  notes: string[];
};

function readNumber(name: string, fallback = Number.NaN): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const TEMP_MIN = readNumber("TEMPERATURE_MIN_C", 30.2);
const TEMP_MAX = readNumber("TEMPERATURE_MAX_C", 33.0);
const MOISTURE_MIN = readNumber("MOISTURE_MIN_PERCENT");
const MOISTURE_MAX = readNumber("MOISTURE_MAX_PERCENT");
const DRY_PF = readNumber("MOISTURE_DRY_CALIBRATION_PF");
const WET_PF = readNumber("MOISTURE_WET_CALIBRATION_PF");
const TEMP_RANGE_VALID = Number.isFinite(TEMP_MIN) && Number.isFinite(TEMP_MAX) && TEMP_MIN < TEMP_MAX;

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const validNullableNumber = (v: unknown) => v === null || isFiniteNumber(v);
const isSensorStatus = (v: unknown): v is SensorStatus =>
  ["ok", "disconnected", "error", "warming_up"].includes(String(v));

export function validateTelemetry(input: unknown): input is IncomingTelemetry {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const x = input as Record<string, unknown>;
  if (x.schemaVersion !== 1 || typeof x.deviceId !== "string" || !x.deviceId.trim()) return false;
  if (typeof x.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(x.timestamp) || Number.isNaN(Date.parse(x.timestamp))) return false;
  if (!Number.isSafeInteger(x.sequence) || Number(x.sequence) < 0) return false;

  const sensors = x.sensors as Record<string, unknown> | undefined;
  const temp = sensors?.temperature as Record<string, unknown> | undefined;
  const cap = sensors?.capacitance as Record<string, unknown> | undefined;
  if (!temp || !cap) return false;
  if (temp.unit !== "degC" || !validNullableNumber(temp.value) || !isSensorStatus(temp.status)) return false;
  if (cap.unit !== "pF" || !isSensorStatus(cap.status)) return false;
  return ["cin1", "cin2", "cin3"].every((key) => validNullableNumber(cap[key]));
}

function capacitanceToMoisture(values: Array<number | null>): number | null {
  if (![DRY_PF, WET_PF].every(Number.isFinite) || DRY_PF === WET_PF) return null;
  const usable = values.filter((value): value is number => isFiniteNumber(value));
  if (usable.length !== 3) return null;
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  const percent = ((average - DRY_PF) / (WET_PF - DRY_PF)) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}

export function processTelemetry(data: IncomingTelemetry): ProcessedTelemetry {
  const temp = data.sensors.temperature;
  const cap = data.sensors.capacitance;
  const tempOk = TEMP_RANGE_VALID && temp.status === "ok" && isFiniteNumber(temp.value);
  const tempStatus: ProcessedTelemetry["temperature"]["status"] = !tempOk
    ? "unavailable"
    : temp.value! < TEMP_MIN ? "below_range"
      : temp.value! > TEMP_MAX ? "above_range"
        : "within_range";

  const moistureValue = cap.status === "ok"
    ? capacitanceToMoisture([cap.cin1, cap.cin2, cap.cin3])
    : null;
  const moistureRangeValid =
    Number.isFinite(MOISTURE_MIN) &&
    Number.isFinite(MOISTURE_MAX) &&
    MOISTURE_MIN >= 0 &&
    MOISTURE_MAX <= 100 &&
    MOISTURE_MIN < MOISTURE_MAX;

  const moistureStatus: ProcessedTelemetry["moisture"]["status"] =
    moistureValue === null ? "unavailable"
      : !moistureRangeValid ? "range_not_configured"
        : moistureValue < MOISTURE_MIN ? "below_target"
          : moistureValue > MOISTURE_MAX ? "above_target"
            : "within_target";

  const tempOut = tempStatus === "below_range" || tempStatus === "above_range";
  const moistureOut = moistureStatus === "below_target" || moistureStatus === "above_target";
  const allAvailable =
    tempStatus !== "unavailable" &&
    moistureValue !== null &&
    moistureStatus !== "range_not_configured" &&
    moistureStatus !== "unavailable";

  // Preserve a known out-of-range alert even if the other sensor is unavailable.
  const overallStatus: OverallStatus =
    tempOut || moistureOut ? "needs_attention"
      : allAvailable ? "stable"
        : "unable_to_assess";

  const led: LedState =
    overallStatus === "stable" ? "green"
      : overallStatus === "unable_to_assess" ? "yellow"
        : tempOut && moistureOut ? "red" : "yellow";

  const notes: string[] = [];
  if (!TEMP_RANGE_VALID) notes.push("Temperature reference range configuration is invalid.");
  if (!tempOk) notes.push("Temperature sensor reading is unavailable.");
  if (moistureValue === null) notes.push("Moisture calibration or electrode readings are unavailable.");
  else if (!moistureRangeValid) notes.push("Moisture target range is not configured.");

  return {
    temperature: {
      value: tempOk ? temp.value : null,
      unit: "°C",
      status: tempStatus,
      range: { min: TEMP_MIN, max: TEMP_MAX },
    },
    moisture: {
      value: moistureValue,
      unit: "%",
      status: moistureStatus,
      range: moistureRangeValid ? { min: MOISTURE_MIN, max: MOISTURE_MAX } : null,
    },
    overallStatus,
    led: { state: led },
    notes,
  };
}
