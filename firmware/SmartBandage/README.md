# Smart Bandage — Arduino UNO R4 WiFi firmware

This sketch reads the DS18B20 and ProtoCentral FDC1004, submits raw measurements to the Next.js telemetry API, then uses the API's processed response to update the TFT and three status LEDs.

This is an exhibition prototype, not a medical device or diagnostic system.

## 1. Arduino IDE libraries

Install these through **Sketch → Include Library → Manage Libraries**:

- Arduino_GFX
- OneWire
- DallasTemperature
- Protocentral FDC1004 Capacitive Sensor Library
- ArduinoJson **7.x**
- NTPClient

The UNO R4 WiFi board package supplies WiFiS3, WiFiSSLClient, Wire/Wire1 and WiFiUDP.

## 2. Credentials

Copy `arduino_secrets.h.example` to `arduino_secrets.h` in this folder. Fill in:

- `SECRET_SSID`
- `SECRET_PASS`
- `DEVICE_API_KEY` — must exactly match Vercel's `FLIGHTLAB_DEVICE_KEY`
- `DEVICE_ID` — keep stable for this device
- `API_HOST` — the deployed host only, without `https://`

The real `arduino_secrets.h` is ignored by Git. Do not commit it.

## 3. Wiring

| Hardware | UNO R4 WiFi |
|---|---|
| DS18B20 VCC | 5V |
| DS18B20 GND | GND |
| DS18B20 DATA | D10 |
| 4.7 kΩ pull-up | Between D10 and 5V |
| Red LED anode | D11 through its own 330 Ω resistor |
| Yellow LED anode | D12 through its own 330 Ω resistor |
| Green LED anode | D13 through its own 330 Ω resistor |
| All LED cathodes | GND |
| FDC1004 | Labelled SDA/SCL pins on main I2C bus |

### FDC1004 bus note

The UNO R4 WiFi Qwiic connector is the secondary I²C bus (`Wire1`) and is 3.3 V. This sketch initializes the FDC1004 on `Wire1`. Connect the ProtoCentral breakout's Qwiic socket to the UNO Qwiic socket. Do not feed 5 V into the UNO Qwiic connector.

The previous SDA/SCL jumper wires on the main header are not used by this sketch. The FDC1004 breakout must have a Qwiic connector compatible with the cable.

### TFT shield note

The display uses the previously tested 8-bit parallel Arduino_GFX setup. The shield's microSD interface shares D10–D13 with the DS18B20/LED wiring. Keep the microSD slot empty; this sketch does not use SD/SPI. The previously working TFT constructor and rotation are retained. Change `gfx->setRotation(1)` to `3` only if the panel is upside down.

## 4. Upload

1. Select **Arduino UNO R4 WiFi** in Tools → Board.
2. Select the correct COM port.
3. Open `SmartBandage.ino`.
4. Confirm `arduino_secrets.h` is in the same sketch folder.
5. Upload and open Serial Monitor at 115200 baud.

The sketch samples about every 2 seconds. It synchronizes UTC time through NTP, sends an HTTPS POST to `/api/telemetry`, parses the processed API response, updates the TFT, and sets the LEDs. The sequence counter increments during a boot session; the server orders/replay-checks readings by measurement timestamp so a reboot does not lock out subsequent samples. If Wi-Fi/API/time is unavailable, it does not pretend the system is stable; the yellow LED blinks.

## 5. Firmware/API contract

The firmware sends schema version 1:

```json
{
  "schemaVersion": 1,
  "deviceId": "smart-bandage-01",
  "timestamp": "2026-11-03T10:30:00Z",
  "sequence": 1793701800,
  "sensors": {
    "temperature": { "value": 29.8, "unit": "degC", "status": "ok" },
    "capacitance": {
      "cin1": 12.45,
      "cin2": 11.82,
      "cin3": 13.10,
      "unit": "pF",
      "status": "ok"
    }
  }
}
```

The sequence uses NTP epoch seconds so it remains monotonic across normal device restarts. The API returns processed temperature/moisture status and `processed.led.state` (`green`, `yellow`, or `red`). Raw CIN values are retained server-side but are not returned by the public GET dashboard API.

## 6. Moisture calibration

FDC1004 measures capacitance, not moisture percentage. The backend's simple exhibition conversion averages CIN1–CIN3 and maps the result between two measured reference points:

`moisture % = (average pF - dry reference pF) / (wet reference pF - dry reference pF) × 100`

This is only a prototype calibration model. Measure the actual assembled electrodes under repeatable dry and wet conditions, then set:

- `MOISTURE_DRY_CALIBRATION_PF`
- `MOISTURE_WET_CALIBRATION_PF`

Then set the demonstration target range using `MOISTURE_MIN_PERCENT` and `MOISTURE_MAX_PERCENT`. Until calibration and target values are configured, the website can show the calibration-pending state and the overall status remains **Unable to assess**. Do not treat this percentage as a clinical wound-moisture measurement.

The default temperature reference values are 30.2–33.0 °C for exhibition comparison only. Probe placement and actual wound-bed temperature are not necessarily equivalent; these values do not diagnose infection or establish wound health.

## 7. Troubleshooting

- **FDC1004 not detected:** check the Qwiic cable, correct Qwiic port, 3.3 V supply and common ground; the FDC1004 address is 0x50.
- **Temperature unavailable:** check DS18B20 orientation, D10 and the 4.7 kΩ pull-up.
- **HTTP 401:** device key mismatch between sketch and Vercel.
- **HTTP 400:** inspect the JSON in Serial Monitor and ensure the device clock is synchronized.
- **TLS connection failure:** verify Wi-Fi connectivity and that the API host is correct.
- **TFT orientation:** change rotation from 1 to 3 if needed.
