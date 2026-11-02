/*
  Smart Bandage — Arduino UNO R4 WiFi firmware
  Payload contract: schemaVersion 1
  Exhibition prototype only; not a medical device.

  Pin map:
    DS18B20 DATA -> D10 (4.7k pull-up to 5V)
    Red LED      -> D11 through 330R
    Yellow LED   -> D12 through 330R
    Green LED    -> D13 through 330R
    FDC1004      -> UNO R4 WiFi main SDA/SCL header (Wire)
    TFT          -> 3.5in ILI9486 parallel shield (Arduino_GFX)

  Keep the TFT shield's microSD slot empty. D10-D13 are shared with its
  SD/SPI interface; the sketch does not use the SD card.
*/

#include <WiFiS3.h>
#include <WiFiSSLClient.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <Protocentral_FDC1004.h>
#include <Arduino_GFX_Library.h>
#include <math.h>
#include <time.h>
#include "arduino_secrets.h"

// ---------- Display ----------
Arduino_DataBus *tftBus = new Arduino_UNOPAR8();
Arduino_GFX *gfx = new Arduino_ILI9486(tftBus, 7, 0, false);
static const uint16_t COLOR_BG = 0x1082;
static const uint16_t COLOR_PANEL = 0x2128;
static const uint16_t COLOR_WHITE = 0xFFFF;
static const uint16_t COLOR_MUTED = 0xBDF7;
static const uint16_t COLOR_GREEN = 0x4FE0;
static const uint16_t COLOR_YELLOW = 0xFDE0;
static const uint16_t COLOR_RED = 0xF986;
static const uint16_t COLOR_BLUE = 0x7DFF;

// ---------- Sensors and networking ----------
static const uint8_t TEMP_PIN = 10;
static const uint8_t LED_RED_PIN = 11;
static const uint8_t LED_YELLOW_PIN = 12;
static const uint8_t LED_GREEN_PIN = 13;
static const unsigned long SAMPLE_INTERVAL_MS = 2000;
static const unsigned long WIFI_RETRY_MS = 10000;

OneWire oneWire(TEMP_PIN);
DallasTemperature temperatureSensor(&oneWire);
FDC1004 capacitanceSensor(&Wire, FDC1004_RATE_100HZ);
WiFiUDP ntpUdp;
NTPClient timeClient(ntpUdp, "pool.ntp.org", 0, 60000);
WiFiSSLClient httpsClient;

bool fdcReady = false;
bool timeSynced = false;
unsigned long lastSampleMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastFdcAttemptMs = 0;
unsigned long lastNtpAttemptMs = 0;
float lastTemperature = NAN;
float lastMoisture = NAN;
String lastOverall = "WAITING FOR DATA";
String lastLedState = "yellow";
String lastTemperatureStatus = "Unavailable";
String lastMoistureStatus = "Calibrate first";
String lastMeasuredAt = "Waiting for time sync";
String lastDeviceStatus = "CONNECTING";

// ---------- Small HTTP response ----------
struct HttpResponse {
  int statusCode;
  String body;
};

String readHttpLine(WiFiSSLClient &client, unsigned long timeoutMs = 6000) {
  String line;
  unsigned long started = millis();
  while (millis() - started < timeoutMs) {
    while (client.available()) {
      char c = (char)client.read();
      if (c == '\n') {
        line.replace("\r", "");
        return line;
      }
      line += c;
    }
    if (!client.connected() && !client.available()) break;
    delay(1);
  }
  line.replace("\r", "");
  return line;
}

bool readExact(WiFiSSLClient &client, String &out, size_t count, unsigned long timeoutMs = 6000) {
  unsigned long started = millis();
  size_t received = 0;
  while (received < count && millis() - started < timeoutMs) {
    while (client.available() && received < count) {
      out += (char)client.read();
      received++;
    }
    if (!client.connected() && !client.available()) break;
    delay(1);
  }
  return received == count;
}

bool readChunkedBody(WiFiSSLClient &client, String &body) {
  while (true) {
    String sizeLine = readHttpLine(client);
    int extension = sizeLine.indexOf(';');
    if (extension >= 0) sizeLine = sizeLine.substring(0, extension);
    sizeLine.trim();
    if (sizeLine.length() == 0) return false;

    char *endPtr = nullptr;
    unsigned long chunkSize = strtoul(sizeLine.c_str(), &endPtr, 16);
    if (endPtr == sizeLine.c_str() || chunkSize > 4096) return false;
    if (chunkSize == 0) {
      // Consume optional trailer headers through the empty line.
      while (true) {
        String trailer = readHttpLine(client);
        if (trailer.length() == 0) break;
      }
      return true;
    }

    if (!readExact(client, body, (size_t)chunkSize)) return false;
    String terminator;
    if (!readExact(client, terminator, 2) || terminator != "\r\n") return false;
    if (body.length() > 4096) return false;
  }
}

HttpResponse performPost(const String &jsonBody) {
  HttpResponse response;
  response.statusCode = 0;
  response.body = "";

  httpsClient.stop();
  httpsClient.setTimeout(6000);
  if (!httpsClient.connect(API_HOST, 443)) {
    Serial.println(F("[HTTPS] Connection failed"));
    return response;
  }

  httpsClient.print(F("POST /api/telemetry HTTP/1.1\r\n"));
  httpsClient.print(F("Host: "));
  httpsClient.print(API_HOST);
  httpsClient.print(F("\r\nAuthorization: Bearer "));
  httpsClient.print(DEVICE_API_KEY);
  httpsClient.print(F("\r\nContent-Type: application/json\r\n"));
  httpsClient.print(F("Accept: application/json\r\nConnection: close\r\n"));
  httpsClient.print(F("Content-Length: "));
  httpsClient.print(jsonBody.length());
  httpsClient.print(F("\r\n\r\n"));
  httpsClient.print(jsonBody);

  String statusLine = readHttpLine(httpsClient);
  if (!statusLine.startsWith("HTTP/")) {
    Serial.println(F("[HTTPS] Invalid HTTP status line"));
    httpsClient.stop();
    return response;
  }
  int firstSpace = statusLine.indexOf(' ');
  if (firstSpace >= 0) response.statusCode = statusLine.substring(firstSpace + 1).toInt();

  int contentLength = -1;
  bool chunked = false;
  while (true) {
    String header = readHttpLine(httpsClient);
    if (header.length() == 0) break;
    String lower = header;
    lower.toLowerCase();
    if (lower.startsWith("content-length:")) contentLength = header.substring(header.indexOf(':') + 1).toInt();
    if (lower.startsWith("transfer-encoding:") && lower.indexOf("chunked") >= 0) chunked = true;
  }

  bool bodyOk = true;
  if (chunked) {
    bodyOk = readChunkedBody(httpsClient, response.body);
  } else if (contentLength >= 0) {
    bodyOk = readExact(httpsClient, response.body, (size_t)contentLength);
  } else {
    unsigned long started = millis();
    while ((httpsClient.connected() || httpsClient.available()) && millis() - started < 6000) {
      while (httpsClient.available()) response.body += (char)httpsClient.read();
      if (response.body.length() > 4096) break;
      delay(1);
    }
  }

  if (!bodyOk) Serial.println(F("[HTTPS] Incomplete response body"));
  httpsClient.stop();
  return response;
}

// ---------- Sensor acquisition ----------
bool readTemperature(float &value) {
  temperatureSensor.requestTemperatures();
  float reading = temperatureSensor.getTempCByIndex(0);
  if (!isfinite(reading) || reading <= -100.0f || reading > 125.0f) return false;
  value = reading;
  return true;
}

bool readCapacitance(float &cin1, float &cin2, float &cin3) {
  if (!fdcReady) return false;
  float a = capacitanceSensor.getCapacitancePicofarads(FDC1004_CHANNEL_0);
  float b = capacitanceSensor.getCapacitancePicofarads(FDC1004_CHANNEL_1);
  float c = capacitanceSensor.getCapacitancePicofarads(FDC1004_CHANNEL_2);
  if (!isfinite(a) || !isfinite(b) || !isfinite(c)) return false;
  cin1 = a;
  cin2 = b;
  cin3 = c;
  return true;
}

String makeUtcTimestamp(unsigned long epoch) {
  time_t raw = (time_t)epoch;
  struct tm *utc = gmtime(&raw);
  if (!utc) return "";
  char buffer[25];
  snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02dZ",
    utc->tm_year + 1900, utc->tm_mon + 1, utc->tm_mday,
    utc->tm_hour, utc->tm_min, utc->tm_sec);
  return String(buffer);
}

String makeLocalClock(unsigned long epoch) {
  time_t localEpoch = (time_t)(epoch + 19800UL); // Asia/Kolkata, UTC+05:30
  struct tm *local = gmtime(&localEpoch);
  if (!local) return "Time unavailable";
  char buffer[20];
  snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d IST",
    local->tm_hour, local->tm_min, local->tm_sec);
  return String(buffer);
}

String buildPayload(float temperature, bool temperatureOk,
                    float cin1, float cin2, float cin3, bool capacitanceOk,
                    const String &timestamp, unsigned long sequence) {
  JsonDocument doc;
  doc["schemaVersion"] = 1;
  doc["deviceId"] = DEVICE_ID;
  doc["timestamp"] = timestamp;
  doc["sequence"] = sequence;

  JsonObject sensors = doc["sensors"].to<JsonObject>();
  JsonObject temp = sensors["temperature"].to<JsonObject>();
  if (temperatureOk) temp["value"] = temperature;
  else temp["value"] = nullptr;
  temp["unit"] = "degC";
  temp["status"] = temperatureOk ? "ok" : "error";

  JsonObject cap = sensors["capacitance"].to<JsonObject>();
  if (capacitanceOk) {
    cap["cin1"] = cin1;
    cap["cin2"] = cin2;
    cap["cin3"] = cin3;
  } else {
    cap["cin1"] = nullptr;
    cap["cin2"] = nullptr;
    cap["cin3"] = nullptr;
  }
  cap["unit"] = "pF";
  cap["status"] = capacitanceOk ? "ok" : (fdcReady ? "error" : "disconnected");

  String body;
  body.reserve(512);
  serializeJson(doc, body);
  return body;
}

// ---------- LEDs and TFT ----------
void setLeds(const char *state) {
  digitalWrite(LED_RED_PIN, strcmp(state, "red") == 0 ? HIGH : LOW);
  digitalWrite(LED_YELLOW_PIN, strcmp(state, "yellow") == 0 ? HIGH : LOW);
  digitalWrite(LED_GREEN_PIN, strcmp(state, "green") == 0 ? HIGH : LOW);
}

void setOfflineLed() {
  digitalWrite(LED_RED_PIN, LOW);
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_YELLOW_PIN, ((millis() / 350) % 2) ? HIGH : LOW);
}

void drawLabel(int16_t x, int16_t y, const char *label, uint16_t color, uint8_t size = 1) {
  gfx->setTextSize(size);
  gfx->setTextColor(color);
  gfx->setCursor(x, y);
  gfx->print(label);
}

void drawDashboard(const String &overall, const String &deviceStatus,
                   float temperature, bool temperatureValid,
                   float moisture, bool moistureValid,
                   const String &clockText, bool apiOk) {
  int16_t width = gfx->width();
  int16_t height = gfx->height();
  gfx->fillScreen(COLOR_BG);

  drawLabel(12, 10, "SMART BANDAGE", COLOR_WHITE, 2);
  drawLabel(width - 105, 14, apiOk ? "ONLINE" : "OFFLINE", apiOk ? COLOR_GREEN : COLOR_YELLOW, 1);

  uint16_t statusColor = lastLedState == "green" ? COLOR_GREEN :
                         lastLedState == "red" ? COLOR_RED : COLOR_YELLOW;
  gfx->fillRect(10, 42, width - 20, 54, COLOR_PANEL);
  gfx->drawRect(10, 42, width - 20, 54, statusColor);
  drawLabel(20, 49, "OVERALL STATUS", COLOR_MUTED, 1);
  drawLabel(20, 68, overall.c_str(), statusColor, 2);

  int16_t gap = 8;
  int16_t cardWidth = (width - 30 - gap) / 2;
  int16_t cardY = 108;
  int16_t cardH = 122;
  int16_t secondX = 20 + cardWidth + gap;

  gfx->fillRect(10, cardY, cardWidth, cardH, COLOR_PANEL);
  gfx->drawRect(10, cardY, cardWidth, cardH, COLOR_BLUE);
  drawLabel(18, cardY + 10, "TEMPERATURE", COLOR_MUTED, 1);
  if (temperatureValid) {
    char value[20];
    snprintf(value, sizeof(value), "%.1f C", temperature);
    drawLabel(18, cardY + 42, value, COLOR_WHITE, width < 360 ? 2 : 3);
    drawLabel(18, cardY + 82, lastTemperatureStatus.c_str(), COLOR_MUTED, 1);
  } else {
    drawLabel(18, cardY + 48, "NO DATA", COLOR_YELLOW, 2);
    drawLabel(18, cardY + 82, lastTemperatureStatus.c_str(), COLOR_MUTED, 1);
  }

  gfx->fillRect(secondX, cardY, cardWidth, cardH, COLOR_PANEL);
  gfx->drawRect(secondX, cardY, cardWidth, cardH, COLOR_BLUE);
  drawLabel(secondX + 8, cardY + 10, "MOISTURE", COLOR_MUTED, 1);
  if (moistureValid) {
    char value[20];
    snprintf(value, sizeof(value), "%.1f%%", moisture);
    drawLabel(secondX + 8, cardY + 42, value, COLOR_WHITE, width < 360 ? 2 : 3);
    drawLabel(secondX + 8, cardY + 82, lastMoistureStatus.c_str(), COLOR_MUTED, 1);
  } else {
    drawLabel(secondX + 8, cardY + 48, "CALIBRATE", COLOR_YELLOW, 2);
    drawLabel(secondX + 8, cardY + 82, lastMoistureStatus.c_str(), COLOR_MUTED, 1);
  }

  int16_t footerY = cardY + cardH + 18;
  drawLabel(12, footerY, "LAST MEASUREMENT", COLOR_MUTED, 1);
  drawLabel(12, footerY + 19, clockText.c_str(), COLOR_WHITE, 2);
  drawLabel(12, footerY + 52, deviceStatus.c_str(), apiOk ? COLOR_GREEN : COLOR_YELLOW, 1);
  if (height > footerY + 90) {
    drawLabel(12, height - 22, "EXHIBITION MONITORING MODEL", COLOR_MUTED, 1);
  }
}

bool applyApiResponse(const String &body) {
  JsonDocument responseDoc;
  DeserializationError error = deserializeJson(responseDoc, body);
  if (error) {
    Serial.print(F("[API] JSON parse failed: "));
    Serial.println(error.c_str());
    return false;
  }

  const char *led = responseDoc["processed"]["led"]["state"] | "yellow";
  const char *status = responseDoc["processed"]["overallStatus"] | "unable_to_assess";
  lastOverall = String(status);
  if (lastOverall == "stable") lastOverall = "STABLE";
  else if (lastOverall == "needs_attention") lastOverall = "NEEDS ATTENTION";
  else lastOverall = "UNABLE TO ASSESS";

  if (strcmp(led, "green") == 0 || strcmp(led, "yellow") == 0 || strcmp(led, "red") == 0) {
    lastLedState = String(led);
  } else {
    lastLedState = "yellow";
  }

  const char *tempStatus = responseDoc["processed"]["temperature"]["status"] | "unavailable";
  const char *moistureStatus = responseDoc["processed"]["moisture"]["status"] | "unavailable";
  auto friendly = [](const char *value) -> String {
    if (strcmp(value, "within_range") == 0 || strcmp(value, "within_target") == 0) return "Within range";
    if (strcmp(value, "below_range") == 0 || strcmp(value, "below_target") == 0) return "Below range";
    if (strcmp(value, "above_range") == 0 || strcmp(value, "above_target") == 0) return "Above range";
    if (strcmp(value, "range_not_configured") == 0) return "Target not set";
    return "Unavailable";
  };
  lastTemperatureStatus = friendly(tempStatus);
  lastMoistureStatus = friendly(moistureStatus);

  JsonVariantConst tempValue = responseDoc["processed"]["temperature"]["value"];
  lastTemperature = tempValue.isNull() ? NAN : (float)tempValue.as<float>();
  JsonVariantConst moistureValue = responseDoc["processed"]["moisture"]["value"];
  lastMoisture = moistureValue.isNull() ? NAN : (float)moistureValue.as<float>();

  lastDeviceStatus = "API CONNECTED";
  setLeds(lastLedState.c_str());
  return true;
}

// ---------- Setup and main loop ----------
void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(LED_RED_PIN, OUTPUT);
  pinMode(LED_YELLOW_PIN, OUTPUT);
  pinMode(LED_GREEN_PIN, OUTPUT);
  setLeds("yellow");

  gfx->begin();
  gfx->setRotation(1); // Change to 3 if the display is upside down.
  drawDashboard("STARTING", "INITIALIZING", NAN, false, NAN, false, "Waiting for time sync", false);

  temperatureSensor.begin();

  // Use the main SDA/SCL header pins, matching the existing jumper wiring.
  Wire.begin();
  fdcReady = capacitanceSensor.begin();
  Serial.println(fdcReady ? F("[FDC1004] Connected on Wire1") : F("[FDC1004] Not detected on Wire1"));

  timeClient.begin();
  WiFi.begin(SECRET_SSID, SECRET_PASS);
  lastWifiAttemptMs = millis();
  lastSampleMs = millis() - SAMPLE_INTERVAL_MS;
}

void loop() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    setOfflineLed();
    lastDeviceStatus = "WIFI DISCONNECTED";
    if (now - lastWifiAttemptMs >= WIFI_RETRY_MS) {
      Serial.println(F("[WiFi] Reconnecting..."));
      WiFi.begin(SECRET_SSID, SECRET_PASS);
      lastWifiAttemptMs = now;
    }
  } else {
    if (!timeSynced || now - lastNtpAttemptMs >= 60000UL) {
      if (timeClient.forceUpdate()) {
        timeSynced = true;
        Serial.println(F("[NTP] Clock synchronized"));
      }
      lastNtpAttemptMs = now;
    } else {
      timeClient.update();
    }

    if (!fdcReady && now - lastFdcAttemptMs >= 10000UL) {
      fdcReady = capacitanceSensor.begin();
      lastFdcAttemptMs = now;
    }
  }

  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;

    float temp = NAN;
    float cin1 = NAN, cin2 = NAN, cin3 = NAN;
    bool tempOk = readTemperature(temp);
    bool capOk = readCapacitance(cin1, cin2, cin3);

    if (tempOk) lastTemperature = temp;
    else lastTemperature = NAN;

    if (WiFi.status() == WL_CONNECTED && timeSynced) {
      unsigned long epoch = timeClient.getEpochTime();
      static uint32_t sequenceCounter = 0;
      sequenceCounter++;
      String timestamp = makeUtcTimestamp(epoch);
      lastMeasuredAt = makeLocalClock(epoch);
      String payload = buildPayload(temp, tempOk, cin1, cin2, cin3, capOk, timestamp, sequenceCounter);

      Serial.println(F("[POST] Sending telemetry"));
      Serial.println(payload);
      HttpResponse response = performPost(payload);
      Serial.print(F("[HTTPS] Status: "));
      Serial.println(response.statusCode);

      if (response.statusCode == 201 && applyApiResponse(response.body)) {
        Serial.println(F("[API] Telemetry accepted; TFT and LEDs updated"));
        drawDashboard(lastOverall, lastDeviceStatus,
          lastTemperature, isfinite(lastTemperature),
          lastMoisture, isfinite(lastMoisture),
          lastMeasuredAt, true);
      } else {
        setOfflineLed();
        lastLedState = "yellow";
        lastDeviceStatus = "API UNAVAILABLE";
        drawDashboard("UNABLE TO ASSESS", lastDeviceStatus,
          lastTemperature, isfinite(lastTemperature),
          lastMoisture, isfinite(lastMoisture),
          lastMeasuredAt, false);
        Serial.println(F("[API] No valid status returned; yellow LED indicates unavailable"));
      }
    } else {
      setOfflineLed();
      lastLedState = "yellow";
      lastOverall = "UNABLE TO ASSESS";
      lastDeviceStatus = "WAITING FOR WIFI / TIME";
      drawDashboard(lastOverall, lastDeviceStatus,
        lastTemperature, isfinite(lastTemperature),
        lastMoisture, isfinite(lastMoisture),
        lastMeasuredAt, false);
    }
  }

  delay(10);
}
