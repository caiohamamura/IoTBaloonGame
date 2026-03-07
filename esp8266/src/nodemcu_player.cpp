#include <ESP8266WiFi.h>
#include <WebsocketsClient.h>
#include <ArduinoJson.h>


// ──────────────────────────────────────────────
//  USER CONFIG  ← edit these
// ──────────────────────────────────────────────
const char* WIFI_SSID    = "LAB6";
const char* SERVER_HOST  = "10.134.76.100";  // IP of the FastAPI server
const int   SERVER_PORT  = 8000;
const char* WS_PATH      = "/ws/device";
const char* PLAYER_NAME  = "Caio";        // max 8 chars

// ──────────────────────────────────────────────
//  PINS
// ──────────────────────────────────────────────
const int PIN_LED = D1; // LED em Dreno
const int PIN_BUTTON = D6; // Botao em PULL_UP

// ──────────────────────────────────────────────
//  GLOBALS
// ──────────────────────────────────────────────
WebSocketsClient ws;

bool     ledState      = false;
bool     wsConnected   = false;
bool     joined        = false;

bool     buttonWasLow  = false;
uint32_t lastDebounce  = 0;
uint32_t joinRetryAt   = 0;

const uint32_t DEBOUNCE_MS   = 50;
const uint32_t JOIN_RETRY_MS = 5000;

// ──────────────────────────────────────────────
//  LED HELPERS
// ──────────────────────────────────────────────
void setLed(bool on) {
  ledState = on;
  digitalWrite(PIN_LED, on ? LOW : HIGH);
}

void blinkLed(int times, int ms) {
  bool saved = ledState;
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_LED, LOW);
    delay(ms);
    digitalWrite(PIN_LED, HIGH);
    delay(ms);
  }
  digitalWrite(PIN_LED, saved ? LOW : HIGH);
}

// ──────────────────────────────────────────────
//  SEND JSON HELPERS
// ──────────────────────────────────────────────
void sendJoin() {
  JsonDocument doc;
  doc["type"] = "join";
  doc["name"] = PLAYER_NAME;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
  joined = true;
  Serial.print("[WS] Sent join: ");
  Serial.println(PLAYER_NAME);
  blinkLed(3, 120);   // 3 blinks = joined
}

void sendShoot() {
  JsonDocument doc;
  doc["type"] = "shoot";
  doc["name"] = PLAYER_NAME;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
  Serial.println("[WS] Sent shoot");
}

// ──────────────────────────────────────────────
//  WEBSOCKET EVENT HANDLER
// ──────────────────────────────────────────────
void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {

    case WStype_DISCONNECTED:
      wsConnected = false;
      joined      = false;
      setLed(false);
      Serial.println("[WS] Disconnected");
      break;

    case WStype_CONNECTED:
      wsConnected = true;
      Serial.print("[WS] Connected to ");
      Serial.println((char*)payload);
      // Send join immediately after connecting
      joinRetryAt = 0;   // trigger join on next loop
      break;

    case WStype_TEXT: {
      // Parse incoming JSON from server
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.print("[WS] JSON parse error: ");
        Serial.println(err.c_str());
        break;
      }

      const char* msgType = doc["type"];
      if (msgType && strcmp(msgType, "led") == 0) {
        bool on = doc["on"] | false;
        setLed(on);
        Serial.print("[LED] ");
        Serial.println(on ? "ON – balloon in zone!" : "OFF");
      }
      break;
    }

    default:
      break;
  }
}

// ──────────────────────────────────────────────
//  WIFI CONNECT
// ──────────────────────────────────────────────
void connectWiFi() {
  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(250);
    Serial.print(".");
    if (millis() - start > 15000) {
      Serial.println("\n[WiFi] Timeout – restarting");
      ESP.restart();
    }
  }
  Serial.print("\n[WiFi] IP: ");
  Serial.println(WiFi.localIP());
}

// ──────────────────────────────────────────────
//  SETUP
// ──────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Bloons Siege Device ===");

  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH);   // LED off
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  connectWiFi();

  // Configure WebSocket client
  ws.begin(SERVER_HOST, SERVER_PORT, WS_PATH);
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);   // retry every 3 s if disconnected
  ws.enableHeartbeat(15000, 3000, 2);  // ping every 15 s

  blinkLed(5, 80);
  Serial.println("[READY]");
}

bool touching = false;
void handleButton() {
  bool isPressed = digitalRead(PIN_BUTTON) == LOW;
  if (isPressed && !touching) {
    sendShoot();
    touching = true;
    Serial.println("[BUTTON]");
  } else if(!isPressed && touching) {
    touching = false;
    Serial.println("[BUTTON RELEASED]");
  }
  
}

// ──────────────────────────────────────────────
//  LOOP
// ──────────────────────────────────────────────
void loop() {
  ws.loop();   // must be called as fast as possible

  uint32_t now = millis();

  // Auto-join once connected (with retry in case the lobby wasn't ready)
  if (wsConnected && !joined && now >= joinRetryAt) {
    sendJoin();
    joinRetryAt = now + JOIN_RETRY_MS;
  }

  handleButton();
}
