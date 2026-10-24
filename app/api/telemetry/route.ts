import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LATEST_KEY = "flightlab:telemetry:latest";
const HISTORY_KEY = "flightlab:telemetry:history";

type RedisResult = {
  result?: unknown;
  error?: string;
};

async function redisPipeline(
  commands: (string | number)[][]
): Promise<RedisResult[]> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error("Redis configuration is missing");
  }

  const response = await fetch(
    `${url.replace(/\/+$/, "")}/pipeline`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    throw new Error("Redis request failed");
  }

  const result: unknown = await response.json();

  if (!Array.isArray(result)) {
    throw new Error("Unexpected Redis response");
  }

  const results = result as RedisResult[];

  if (results.some((item) => item?.error)) {
    throw new Error("A Redis command failed");
  }

  return results;
}

export async function POST(request: Request) {
  const deviceKey = process.env.FLIGHTLAB_DEVICE_KEY;

  if (!deviceKey) {
    return NextResponse.json(
      { error: "Device authentication is not configured" },
      { status: 503 }
    );
  }

  if (
    request.headers.get("authorization") !==
    `Bearer ${deviceKey}`
  ) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const contentLength = Number(
    request.headers.get("content-length") ?? 0
  );

  if (contentLength > 16384) {
    return NextResponse.json(
      { error: "Payload too large" },
      { status: 413 }
    );
  }

  let data: unknown;

  try {
    data = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400 }
    );
  }

  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return NextResponse.json(
      { error: "Expected a JSON object" },
      { status: 400 }
    );
  }

  const reading = {
    receivedAt: new Date().toISOString(),
    data,
  };

  try {
    await redisPipeline([
      ["SET", LATEST_KEY, JSON.stringify(reading), "EX", 86400],
      ["LPUSH", HISTORY_KEY, JSON.stringify(reading)],
      ["LTRIM", HISTORY_KEY, 0, 14999],
      ["EXPIRE", HISTORY_KEY, 86400],
    ]);

    return NextResponse.json(
      { ok: true, receivedAt: reading.receivedAt },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { error: "Could not store telemetry" },
      { status: 502 }
    );
  }
}

export async function GET() {
  try {
    const results = await redisPipeline([
      ["GET", LATEST_KEY],
    ]);

    const raw = results[0]?.result;

    return NextResponse.json({
      ok: true,
      latest: raw ? JSON.parse(String(raw)) : null,
    });
  } catch {
    return NextResponse.json(
      { error: "Could not read telemetry" },
      { status: 502 }
    );
  }
}
