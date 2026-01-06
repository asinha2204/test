/**
 * Twilio ↔ OpenAI Realtime Voice Bridge (Render-friendly)
 *
 * - Twilio Voice <Connect><Stream> WebSocket at /twilio/stream
 * - OpenAI Realtime WebSocket (model configurable)
 * - Audio: G.711 μ-law / PCMU (8kHz) end-to-end for Twilio compatibility
 *
 * Your OpenAI stored prompt controls:
 * - personality + practice knowledge
 * - greeting content
 * - turn detection + transcription
 * - voice (if set in the prompt UI)
 *
 * This server:
 * - enforces PCMU audio formats (so Twilio works)
 * - triggers the model to greet first with response.create
 */

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

// Prefer the stable model; you can override in Render env vars if you want
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";

// Use your published prompt ID (pmpt_...) from the OpenAI Audio/Reatime prompt UI
const OPENAI_PROMPT_ID =
  process.env.OPENAI_PROMPT_ID ||
  "pmpt_695d8e5a7cb88190a34980502b32e54e08cfeea11c319dd2"; // <-- optional default

// Optional: override public base URL (useful if you ever need it)
// Can be: https://your-app.onrender.com OR wss://your-app.onrender.com
const BASE_URL = process.env.BASE_URL;

// OpenAI Realtime WS URL
const OPENAI_REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ||
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;

// Buffering so the greeting truly happens "first"
const MAX_BUFFERED_FRAMES = 400; // ~8s if frames are 20ms
const GREETING_START_TIMEOUT_MS = 1200;

// -------------------- Helpers --------------------
function normalizeWssBaseUrl(input, req) {
  // If BASE_URL is provided, normalize to wss://...
  if (input && typeof input === "string") {
    let base = input.trim().replace(/\/+$/, ""); // trim trailing slashes
    if (base.startsWith("https://")) base = "wss://" + base.slice("https://".length);
    if (base.startsWith("http://")) base = "ws://" + base.slice("http://".length);
    if (base.startsWith("wss://") || base.startsWith("ws://")) return base;

    // If they gave just a hostname
    return `wss://${base}`;
  }

  // Otherwise build from request host; Twilio needs WSS in production anyway.
  const host = req.get("host");
  return `wss://${host}`;
}

function safeJsonParse(buffer) {
  try {
    return JSON.parse(buffer.toString());
  } catch (e) {
    return null;
  }
}

// -------------------- Express app --------------------
const app = express();
app.set("trust proxy", true); // Render/proxies

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/health", (req, res) => res.status(200).send("OK"));

// Twilio Voice webhook: returns TwiML to start the bidirectional Media Stream
app.post("/twilio/voice", (req, res) => {
  const wssBase = normalizeWssBaseUrl(BASE_URL, req);
  const streamUrl = `${wssBase}/twilio/stream`;

  console.log(`[Twilio Voice] Incoming call → streaming to: ${streamUrl}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="app" value="pathir-voice-bridge" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -------------------- HTTP + WS servers --------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

// Per-call handler (each Twilio WS connection = one call stream)
wss.on("connection", (twilioWs) => {
  console.log("[Twilio WS] Connected");

  let streamSid = null;

  // OpenAI WS + state
  let openaiWs = null;
  let openaiReady = false;

  // We want the model to greet first. So we buffer user audio until greeting finishes.
  let greetingInProgress = false;
  let greetingStarted = false;
  let greetingStartTimer = null;

  // Buffer inbound frames until OpenAI is ready (and until greeting is done)
  const inboundAudioQueue = [];

  function enqueueAudioFrame(base64Pcmu) {
    inboundAudioQueue.push(base64Pcmu);
    if (inboundAudioQueue.length > MAX_BUFFERED_FRAMES) {
      inboundAudioQueue.shift(); // drop oldest
    }
  }

  function flushQueuedAudioToOpenAI() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !openaiReady) return;
    while (inboundAudioQueue.length) {
      const payload = inboundAudioQueue.shift();
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload,
        })
      );
    }
  }

  function sendResponseCreateToGreet() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    greetingInProgress = true;
    greetingStarted = false;

    // Safety: if the prompt doesn't actually speak, don't block user audio forever
    if (greetingStartTimer) clearTimeout(greetingStartTimer);
    greetingStartTimer = setTimeout(() => {
      if (!greetingStarted) {
        console.log("[OpenAI] Greeting didn't start quickly; releasing buffered user audio.");
        greetingInProgress = false;
        flushQueuedAudioToOpenAI();
      }
    }, GREETING_START_TIMEOUT_MS);

    // Trigger the model to speak first.
    // The content of the greeting comes from your stored prompt.
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
        },
      })
    );
  }

  function connectToOpenAI() {
    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openaiWs.on("open", () => {
      console.log("[OpenAI WS] Connected");

      // Session update:
      // - Use your server-stored prompt by ID
      // - Enforce PCMU in/out for Twilio
      // - Do NOT set turn detection or transcription here (prompt controls them)
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: OPENAI_MODEL,

          // Ensure we get audio out (text is helpful for logs/debug)
          output_modalities: ["audio", "text"],

          // Stored prompt (you edit this in the OpenAI UI)
          prompt: {
            id: OPENAI_PROMPT_ID,
          },

          // Twilio-compatible audio formats
          audio: {
            input: {
              format: { type: "audio/pcmu" },
            },
            output: {
              format: { type: "audio/pcmu" },
              // voice intentionally NOT set here → prompt controls voice
            },
          },
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      console.log("[OpenAI WS] Sent session.update (prompt-driven)");
    });

    openaiWs.on("message", (data) => {
      const event = safeJsonParse(data);
      if (!event || !event.type) return;

      switch (event.type) {
        case "session.created":
          console.log("[OpenAI] session.created");
          break;

        case "session.updated":
          console.log("[OpenAI] session.updated → OpenAI ready");
          openaiReady = true;

          // Important: greet first, using the prompt’s greeting behavior
          sendResponseCreateToGreet();
          break;

        // --- Audio out (handle both newer + older event names) ---
        case "response.output_audio.delta":
        case "response.audio.delta": {
          const delta = event.delta;
          if (!delta) break;

          // Greeting has started (so we can stop the timeout)
          if (greetingInProgress && !greetingStarted) {
            greetingStarted = true;
            if (greetingStartTimer) clearTimeout(greetingStartTimer);
          }

          // Forward to Twilio
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: delta },
              })
            );
          }
          break;
        }

        case "response.output_audio.done":
        case "response.audio.done":
          // If the greeting just finished, release buffered user audio
          if (greetingInProgress) {
            greetingInProgress = false;
            flushQueuedAudioToOpenAI();
          }
          break;

        // Optional: debug text output if you enabled it
        case "response.output_text.delta":
        case "response.text.delta":
          if (event.delta) process.stdout.write(event.delta);
          break;

        case "conversation.item.input_audio_transcription.completed":
          // Only appears if transcription is enabled (prompt controls this)
          if (process.env.LOG_TRANSCRIPTS === "1") {
            console.log("[OpenAI] User said:", event.transcript);
          }
          break;

        case "error":
          console.error("[OpenAI] Error:", event.error || event);
          break;

        default:
          // Uncomment for deep debugging:
          // console.log("[OpenAI] Event:", event.type);
          break;
      }
    });

    openaiWs.on("close", (code, reason) => {
      console.log(`[OpenAI WS] Closed: ${code} ${reason || ""}`);
      openaiReady = false;
      greetingInProgress = false;
      greetingStarted = false;
      if (greetingStartTimer) clearTimeout(greetingStartTimer);
    });

    openaiWs.on("error", (err) => {
      console.error("[OpenAI WS] Error:", err.message);
    });
  }

  // -------------------- Twilio WS inbound --------------------
  twilioWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg || !msg.event) return;

    switch (msg.event) {
      case "connected":
        console.log("[Twilio] connected");
        break;

      case "start":
        streamSid = msg.start?.streamSid || null;
        console.log(`[Twilio] start streamSid=${streamSid} callSid=${msg.start?.callSid}`);
        connectToOpenAI();
        break;

      case "media": {
        const payload = msg.media?.payload;
        if (!payload) break;

        // Always buffer during:
        // - OpenAI not ready yet
        // - greeting still in progress (so the agent speaks first)
        if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !openaiReady || greetingInProgress) {
          enqueueAudioFrame(payload);
          break;
        }

        // Forward audio straight through
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload,
          })
        );
        break;
      }

      case "stop":
        console.log("[Twilio] stop");
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
        break;

      default:
        break;
    }
  });

  twilioWs.on("close", (code, reason) => {
    console.log(`[Twilio WS] Closed: ${code} ${reason || ""}`);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    if (greetingStartTimer) clearTimeout(greetingStartTimer);
  });

  twilioWs.on("error", (err) => {
    console.error("[Twilio WS] Error:", err.message);
  });
});

// -------------------- Start --------------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Twilio webhook: POST http://localhost:${PORT}/twilio/voice`);
  console.log(`Twilio WS endpoint: ws://localhost:${PORT}/twilio/stream`);
});

