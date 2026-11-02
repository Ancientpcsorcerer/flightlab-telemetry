import { NextResponse } from "next/server";
import { processTelemetry, validateTelemetry, type IncomingTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LATEST_KEY = "flightlab:telemetry:latest";
const HISTORY_KEY = "flightlab:telemetry:history";
const MAX_AGE_MS = 15_000;
const OFFLINE_AGE_MS = 60_000;

type RedisResult = { result?: unknown; error?: string };

async function redisPipeline(commands: (string | number)[][]): Promise<RedisResult[]> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Redis configuration is missing");
  const response = await fetch(`${url.replace(/\\/+$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Redis request failed");
  const result: unknown = await response.json();
  if (!Array.isArray(result)) throw new Error("Unexpected Redis response");
  const results = result as RedisResult[];
  if (results.some((item) => item?.error)) throw new Error("A Redis command failed");
  return results;
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const deviceKey = process.env.FLIGHTLAB_DEVICE_KEY;
  if (!deviceKey) return NextResponse.json({ error: "Device authentication is not configured" }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${deviceKey}`) return unauthorized();

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!validateTelemetry(input)) {
    return NextResponse.json({
      error: "Invalid telemetry payload",
      expected: "schemaVersion 1 with deviceId, ISO timestamp, sequence, temperature and CIN1-CIN3 sensor fields",
    }, { status: 400 });
  }

  const data = input as IncomingTelemetry;
  const measuredAtMs = Date.parse(data.timestamp);
  if (Math.abs(Date.now() - measuredAtMs) > 5 * 60_000) {
    return NextResponse.json({ error: "Measurement timestamp is more than five minutes from server time" }, { status: 400 });
  }

  const processed = processTelemetry(data);
  const receivedAt = new Date().toISOString();
  const reading = {
    receivedAt,
    measuredAt: data.timestamp,
    deviceId: data.deviceId,
    sequence: data.sequence,
    raw: data, // retained server-side for calibration/diagnostics; never returned by GET
    processed,
  };

  try {
    // Use the measurement timestamp for replay/order checks. This remains
    // valid across Arduino reboots, where the local sequence counter restarts.
    const currentResult = await redisPipeline([["GET", LATEST_KEY]]);
    const rawCurrent = currentResult[0]?.result;
    if (rawCurrent) {
      try {
        const current = JSON.parse(String(rawCurrent)) as { deviceId?: string; measuredAt?: string };
        if (
          current.deviceId === data.deviceId &&
          typeof current.measuredAt === "string" &&
          Date.parse(current.measuredAt) >= measuredAtMs
        ) {
          return NextResponse.json({ error: "Duplicate or out-of-order measurement timestamp" }, { status: 409 });
        }
      } catch {
        // Replace malformed/legacy cache entries with the next valid reading.
      }
    }

    await redisPipeline([
      ["SET", LATEST_KEY, JSON.stringify(reading), "EX", 86_400],
      ["LPUSH", HISTORY_KEY, JSON.stringify(reading)],
      ["LTRIM", HISTORY_KEY, 0, 149],
      ["EXPIRE", HISTORY_KEY, 86_400],
    ]);

    return NextResponse.json({
      ok: true,
      receivedAt,
      measuredAt: data.timestamp,
      processed,
    }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Could not store telemetry" }, { status: 502 });
  }
}

export async function GET() {
  try {
    const results = await redisPipeline([
      ["GET", LATEST_KEY],
      ["LRANGE", HISTORY_KEY, 0, 59],
    ]);

    const rawLatest = results[0]?.result;
    if (!rawLatest) return NextResponse.json({ ok: true, latest: null, history: [] });

    let stored: {
      receivedAt: string;
      measuredAt: string;
      deviceId: string;
      sequence: number;
      processed: ReturnType<typeof processTelemetry>;
    };
    try {
      const parsed = JSON.parse(String(rawLatest)) as Partial<typeof stored>;
      // Ignore old demo-cache entries from the previous payload format.
      if (
        typeof parsed.receivedAt !== "string" ||
        typeof parsed.measuredAt !== "string" ||
        typeof parsed.deviceId !== "string" ||
        typeof parsed.sequence !== "number" ||
        !parsed.processed
      ) {
        return NextResponse.json({ ok: true, latest: null, history: [] });
      }
      stored = parsed as typeof stored;
    } catch {
      return NextResponse.json({ ok: true, latest: null, history: [] });
    }

    const ageMs = Math.max(0, Date.now() - Date.parse(stored.receivedAt));
    const deviceStatus = ageMs <= MAX_AGE_MS ? "connected" : ageMs <= OFFLINE_AGE_MS ? "stale" : "offline";
    const processed = deviceStatus === "connected"
      ? stored.processed
      : { ...stored.processed, overallStatus: "unable_to_assess" as const, led: { state: "yellow" as const } };

    const rawHistory = Array.isArray(results[1]?.result) ? results[1].result as string[] : [];
    const history = rawHistory.flatMap((item) => {
      try {
        const entry = JSON.parse(item) as {
          measuredAt: string;
          processed: ReturnType<typeof processTelemetry>;
        };
        return [{
          measuredAt: entry.measuredAt,
          temperature: entry.processed.temperature.value,
          moisture: entry.processed.moisture.value,
          overallStatus: entry.processed.overallStatus,
        }];
      } catch {
        return [];
      }
    }).reverse();

    return NextResponse.json({
      ok: true,
      latest: {
        deviceId: stored.deviceId,
        sequence: stored.sequence,
        measuredAt: stored.measuredAt,
        receivedAt: stored.receivedAt,
        deviceStatus,
        processed,
      },
      history,
    });
  } catch {
    return NextResponse.json({ error: "Could not read telemetry" }, { status: 502 });
  }
}
