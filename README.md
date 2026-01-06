# Twilio ↔ OpenAI Realtime Voice Bridge

A minimal Node.js server that bridges Twilio Voice Media Streams to OpenAI's Realtime API, enabling real-time voice conversations with GPT-4o.

## Architecture

```
Phone Call → Twilio → [This Server] → OpenAI Realtime API
                ↑          ↓
            Audio (μ-law 8kHz)
```

## Features

- Bidirectional audio streaming between Twilio and OpenAI
- G.711 μ-law audio format (native to both Twilio and OpenAI)
- Server-side VAD (Voice Activity Detection)
- Automatic greeting on call connect

## Prerequisites

- Node.js 18+
- Twilio account with a phone number
- OpenAI API key with Realtime API access

## Local Development

1. **Clone and install:**
   ```bash
   git clone <this-repo>
   cd twilio-openai-voice-bridge
   npm install
   ```

2. **Set environment variables:**
   ```bash
   export OPENAI_API_KEY=sk-your-openai-api-key
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Expose locally with ngrok (for testing):**
   ```bash
   ngrok http 3000
   ```

5. **Configure Twilio webhook** to your ngrok URL (see below).

---

## Deploy to Render

### Step 1: Push to GitHub

Push this code to a GitHub repository.

### Step 2: Create Render Web Service

1. Go to [render.com](https://render.com) and sign in
2. Click **New +** → **Web Service**
3. Connect your GitHub repo
4. Configure:
   - **Name:** `twilio-openai-bridge` (or your choice)
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Starter ($7/mo) or higher

### Step 3: Add Environment Variables

In Render dashboard, go to **Environment** tab and add:

| Key | Value |
|-----|-------|
| `OPENAI_API_KEY` | `sk-your-openai-api-key` |
| `BASE_URL` | `wss://your-service-name.onrender.com` |

> **Note:** `BASE_URL` ensures the TwiML returns the correct WSS URL. Replace `your-service-name` with your actual Render service name.

### Step 4: Deploy

Click **Deploy**. Wait for the build to complete. You'll get a URL like:
```
https://twilio-openai-bridge.onrender.com
```

### Step 5: Verify Deployment

Check the health endpoint:
```bash
curl https://your-service-name.onrender.com/health
# Should return: OK
```

---

## Configure Twilio

### Step 1: Get Your Render URL

After deploying, note your Render URL:
```
https://your-service-name.onrender.com
```

### Step 2: Configure Twilio Phone Number

1. Go to [Twilio Console](https://console.twilio.com)
2. Navigate to **Phone Numbers** → **Manage** → **Active Numbers**
3. Click on your phone number
4. Under **Voice Configuration**:
   - **Configure with:** Webhook
   - **A call comes in:** Webhook
   - **URL:** `https://your-service-name.onrender.com/twilio/voice`
   - **HTTP Method:** `POST`
5. Click **Save configuration**

### Twilio Webhook URL

```
https://your-service-name.onrender.com/twilio/voice
```

---

## Test Your Setup

1. Call your Twilio phone number
2. You should hear: *"Hello, you're through to the practice. How can I help today?"*
3. Speak to have a conversation with the AI receptionist

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check, returns `200 OK` |
| `/twilio/voice` | POST | Twilio webhook, returns TwiML |
| `/twilio/stream` | WebSocket | Twilio Media Stream endpoint |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `PORT` | No | Server port (default: 3000, set by Render) |
| `BASE_URL` | No | Override WSS URL (e.g., `wss://example.onrender.com`) |

---

## Customization

### Change the AI Personality

Edit the `instructions` in `server.js`:

```javascript
instructions: 'You are a friendly UK dental receptionist. Keep it short. Ask one question at a time.',
```

### Change the Voice

Available voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`

```javascript
voice: 'coral',
```

### Change the Greeting

Edit the `response.create` message:

```javascript
instructions: 'Say a brief greeting: "Hello, you\'re through to the practice. How can I help today?"'
```

---

## Troubleshooting

### No audio / Connection drops immediately
- Verify `OPENAI_API_KEY` is set correctly
- Check Render logs for errors
- Ensure `BASE_URL` starts with `wss://`

### "Error: OPENAI_API_KEY environment variable is required"
- Add `OPENAI_API_KEY` to Render environment variables
- Redeploy after adding

### Twilio returns error
- Verify webhook URL is correct: `https://your-service.onrender.com/twilio/voice`
- Ensure HTTP method is `POST`
- Check Render logs for TwiML generation

### Audio is choppy
- Render Starter instances may have cold starts; consider upgrading
- Check network latency between Render region and OpenAI

---

## Logs

View logs in Render dashboard or use:
```bash
render logs --service your-service-name
```

Key log messages:
- `[Twilio Voice] Incoming call` - Call received
- `[OpenAI WS] Connected` - OpenAI connection established
- `[OpenAI] Session updated` - Ready for conversation
- `[OpenAI] User said: ...` - Transcribed user speech

---

## License

MIT
