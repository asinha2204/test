/**
 * Twilio ↔ OpenAI Realtime Voice Bridge Server
 *
 * Connects Twilio Voice Media Streams (WebSocket) to OpenAI Realtime API (WebSocket)
 * Audio format: G.711 μ-law (PCMU) at 8kHz
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

// Configuration
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.BASE_URL; // Optional: override for WSS URL

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

// Express app setup
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Twilio webhook - returns TwiML to start Media Stream
app.post('/twilio/voice', (req, res) => {
  // Build WebSocket URL from request host or BASE_URL env var
  const host = BASE_URL || `${req.protocol === 'http' ? 'wss' : 'wss'}://${req.get('host')}`;
  const streamUrl = `${host}/twilio/stream`;

  console.log(`[Twilio Voice] Incoming call, streaming to: ${streamUrl}`);

  // Return TwiML with bidirectional Media Stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="greeting" value="connected" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ server, path: '/twilio/stream' });

wss.on('connection', (twilioWs, req) => {
  console.log('[Twilio WS] New connection from Twilio');

  let streamSid = null;
  let openaiWs = null;
  let isOpenAIReady = false;

  // Connect to OpenAI Realtime API
  function connectToOpenAI() {
    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('[OpenAI WS] Connected to OpenAI Realtime API');

      // Configure session for G.711 μ-law audio (matches Twilio)
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: 'You are a friendly UK dental receptionist. Keep it short. Ask one question at a time.',
          voice: 'coral',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      console.log('[OpenAI WS] Sent session.update');
    });

    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        switch (event.type) {
          case 'session.created':
            console.log('[OpenAI] Session created');
            break;

          case 'session.updated':
            console.log('[OpenAI] Session updated, sending initial greeting');
            isOpenAIReady = true;

            // Send initial greeting
            const responseCreate = {
              type: 'response.create',
              response: {
                modalities: ['audio', 'text'],
                instructions: 'Say a brief greeting: "Hello, you\'re through to the practice. How can I help today?"'
              }
            };
            openaiWs.send(JSON.stringify(responseCreate));
            break;

          case 'response.audio.delta':
            // Forward audio to Twilio
            if (streamSid && event.delta) {
              const twilioMessage = {
                event: 'media',
                streamSid: streamSid,
                media: {
                  payload: event.delta
                }
              };

              if (twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify(twilioMessage));
              }
            }
            break;

          case 'response.audio.done':
            console.log('[OpenAI] Audio response complete');
            break;

          case 'response.done':
            console.log('[OpenAI] Response complete');
            break;

          case 'input_audio_buffer.speech_started':
            console.log('[OpenAI] User started speaking');
            break;

          case 'input_audio_buffer.speech_stopped':
            console.log('[OpenAI] User stopped speaking');
            break;

          case 'conversation.item.input_audio_transcription.completed':
            console.log('[OpenAI] User said:', event.transcript);
            break;

          case 'response.text.delta':
            // Log assistant text for debugging
            process.stdout.write(event.delta || '');
            break;

          case 'error':
            console.error('[OpenAI] Error:', event.error);
            break;
        }
      } catch (err) {
        console.error('[OpenAI] Failed to parse message:', err);
      }
    });

    openaiWs.on('close', (code, reason) => {
      console.log(`[OpenAI WS] Disconnected: ${code} ${reason}`);
      isOpenAIReady = false;
    });

    openaiWs.on('error', (err) => {
      console.error('[OpenAI WS] Error:', err.message);
    });
  }

  // Handle messages from Twilio
  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'connected':
          console.log('[Twilio] Media stream connected');
          break;

        case 'start':
          // Stream started - capture streamSid and connect to OpenAI
          streamSid = msg.start.streamSid;
          console.log(`[Twilio] Stream started: ${streamSid}`);
          console.log(`[Twilio] Call SID: ${msg.start.callSid}`);
          console.log(`[Twilio] Media format: ${JSON.stringify(msg.start.mediaFormat)}`);

          // Connect to OpenAI when stream starts
          connectToOpenAI();
          break;

        case 'media':
          // Forward audio to OpenAI
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && isOpenAIReady) {
            const audioAppend = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            };
            openaiWs.send(JSON.stringify(audioAppend));
          }
          break;

        case 'stop':
          console.log('[Twilio] Stream stopped');
          // Clean up OpenAI connection
          if (openaiWs) {
            openaiWs.close();
          }
          break;

        case 'mark':
          // Mark events are sent when audio playback reaches a mark
          console.log('[Twilio] Mark:', msg.mark?.name);
          break;
      }
    } catch (err) {
      console.error('[Twilio] Failed to parse message:', err);
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log(`[Twilio WS] Disconnected: ${code} ${reason}`);
    // Clean up OpenAI connection
    if (openaiWs) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', (err) => {
    console.error('[Twilio WS] Error:', err.message);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Twilio webhook: POST http://localhost:${PORT}/twilio/voice`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/twilio/stream`);
});
