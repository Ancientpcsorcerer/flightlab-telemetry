# Smart Bandage — live telemetry prototype

Next.js dashboard and Arduino UNO R4 WiFi firmware for an exhibition Smart Bandage model.

**This is an educational/exhibition prototype, not a medical device. It does not diagnose infection, wound health, or treatment needs.**

## Architecture

1. Arduino UNO R4 WiFi samples the DS18B20 temperature sensor and three FDC1004 capacitance channels.
2. Arduino sends a versioned JSON payload to `POST /api/telemetry` using HTTPS and a bearer device key.
3. The Next.js API validates the payload, computes the exhibition moisture estimate and applies configured reference ranges.
4. Redis stores the latest processed reading plus raw source readings privately for calibration/diagnostics.
5. `GET /api/telemetry` returns only processed user-facing measurements and recent history. Raw CIN electrode values are not exposed.
6. The Arduino parses the POST response to update the physical TFT and red/yellow/green LEDs. The website polls the GET endpoint every two seconds.

## Repository layout

- `app/page.tsx` — live dashboard
- `app/api/telemetry/route.ts` — authenticated ingest and public processed read endpoint
- `lib/telemetry.ts` — schema validation, conversion and status/LED logic
- `firmware/SmartBandage/` — Arduino sketch and setup guide
- `.env.example` — required server environment variable names

## Vercel environment variables

Set these in **Vercel → Project → Settings → Environment Variables**:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `FLIGHTLAB_DEVICE_KEY`
- `TEMPERATURE_MIN_C` (defaults to 30.2)
- `TEMPERATURE_MAX_C` (defaults to 33.0)
- `MOISTURE_DRY_CALIBRATION_PF`
- `MOISTURE_WET_CALIBRATION_PF`
- `MOISTURE_MIN_PERCENT`
- `MOISTURE_MAX_PERCENT`

Use the existing Upstash Redis REST credentials. Do not commit credentials or API keys.

## API

### POST `/api/telemetry`

Requires `Authorization: Bearer <FLIGHTLAB_DEVICE_KEY>`. Accepts schema version 1 fields: device ID, UTC measurement timestamp, increasing sequence number, temperature value/status, and CIN1–CIN3 capacitance values/status.

On successful storage it returns `201` and the processed result, including `processed.led.state` for the Arduino TFT/LED update.

### GET `/api/telemetry`

Returns the latest processed reading and recent history. It deliberately excludes raw electrode values. The server marks data as connected (≤15 seconds), stale (15–60 seconds), or offline (>60 seconds). A stale/offline device cannot display a stable overall status.

## Status rules

- **Stable / green:** all required measurements are available and within their configured demonstration ranges.
- **Needs attention / yellow:** one measurement is outside its configured range.
- **Needs attention / red:** both temperature and moisture are outside their configured ranges.
- **Unable to assess / yellow:** missing sensor data, missing moisture calibration/target range, or stale/offline device.

These states are monitoring labels for a project demonstration, not medical assessments.

## Temperature and moisture caveats

The default temperature reference range (30.2–33.0 °C) is an example research reference for chronic wound-bed temperature; it is not universal or diagnostic. DS18B20 probe placement on this prototype may not measure wound-bed temperature.

FDC1004 outputs capacitance, not moisture. The current conversion is a basic linear map of mean CIN1–CIN3 between dry and wet calibration points. Calibrate the assembled electrodes using repeatable samples before showing a moisture percentage; configure the target range only after that. The result is a prototype estimate, not clinical moisture measurement.

## Development

```bash
npm ci
npm run lint
npm run build
npm run dev
```

Arduino wiring and upload instructions: [firmware/SmartBandage/README.md](firmware/SmartBandage/README.md).
