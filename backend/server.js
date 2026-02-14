require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");

const SessionManager = require("./sessions/SessionManager");
const { createStreamingSTT } = require("./stt/sttService");
const { generateResponse } = require("./llm/llmService");
const { webSearch } = require("./tools/webSearch");
const { streamTTS } = require("./tts/ttsService");
const { formatForSpeech } = require("./utils/speechFormatter");

const PORT = process.env.PORT || 8080;
const TURN_END_SILENCE_MS = 800;
const TURN_CHECK_INTERVAL_MS = 200;

// 1. Create HTTP Server for Admin API
const server = http.createServer((req, res) => {
  // Add CORS headers for all requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Admin API: POST /admin/context
  if (req.method === "POST" && req.url === "/admin/context") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const { sessionId, content } = JSON.parse(body);

        if (!sessionId || !content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing sessionId or content" }));
          return;
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }

        // Apply Context Update Atomicially
        session.dynamicContext = [{ role: "system", content: content.trim() }];
        session.contextVersion++;
        console.log(`[CONTEXT] Session ${session.sessionId}: updated (v${session.contextVersion}) via ADMIN API`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, version: session.contextVersion }));

      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // Health Check
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// 2. Attach WebSocket Server to HTTP Server
const wss = new WebSocket.Server({ server });
const sessionManager = new SessionManager();

console.log(`Voice Agent Server (HTTP + WS) running on :${PORT}`);

/**
 * Intent Gating Logic: Only trigger search for specific, time-sensitive queries.
 */
function shouldTriggerSearch(query) {
  const q = query.toLowerCase();

  // 1. Skip definitional/vague questions
  const skipPatterns = [
    /^what is [a-z]+$/, // e.g., "what is weather"
    /^explain [a-z]+$/,  // e.g., "explain weather"
    /^is [a-z]+$/,
    /what about the [a-z]+$/ // e.g., "what about the weather"
  ];
  if (skipPatterns.some(p => p.test(q))) return false;

  // 2. Identify time-sensitive or external entity keywords
  const keywords = ["today", "latest", "current", "news", "now", "weather", "stock", "price", "ceo", "score"];
  const hasKeyword = keywords.some(k => q.includes(k));

  // 3. Stricter Specificity Check: Has keyword AND isn't just a basic question
  // e.g. "what is the weather today" (4 words including "today")
  // vs "weather in pune" (3 words including "pune")
  const words = q.split(/\s+/).filter(w => !["what", "is", "the", "about", "a", "an"].includes(w));

  return hasKeyword && words.length >= 2;
}

/**
 * Handle one completed user turn:
 * Uses session.finalTranscript accumulated during streaming.
 */
async function handleUserTurn(session) {
  // Processing lock: prevent concurrent turn processing
  if (session.isProcessingTurn) {
    console.log(`[TURN] Skipping handleUserTurn — already processing (${session.sessionId})`);
    return;
  }
  session.isProcessingTurn = true;

  const transcript = session.finalTranscript.trim();

  // Reset transcript buffers for next turn immediately to avoid leakage
  session.finalTranscript = "";
  session.interimTranscript = "";

  if (!transcript) {
    if (session.interimTranscript.trim().length > 2) {
      transcript = session.interimTranscript.trim();
      console.log(`[TURN] Using interim fallback (${session.sessionId}): ${transcript}`);
    } else {
      console.log(`[USER SAID] (${session.sessionId}): <empty> (Skipping turn)`);
      session.isProcessingTurn = false;

      // Authority: Return to idle/listening depending on mode
      if (session.ws && session.ws.readyState === 1) {
        // If interview active, stay LISTENING (don't get stuck on thinking)
        const nextState = session.isInterviewActive ? "listening" : "idle";
        session.ws.send(JSON.stringify({ type: "state", value: nextState }));
      }
      return;
    }
  }

  console.log(`[STT FINAL COMMIT] (${session.sessionId}): ${transcript}`);

  // STT Metric
  session.sttFinishTime = Date.now();
  session.turnId++;

  try {
    // 1. Append user transcript to history
    session.messages.push({ role: "user", content: transcript });

    // Memory bounding: keep only last 12 entries
    if (session.messages.length > 12) {
      session.messages = session.messages.slice(-12);
    }

    // ── INTERVIEW MODE: Fast path (skip search, use testimonial context directly) ──
    if (session.isInterviewActive) {
      console.log(`[INTERVIEW] Session ${session.sessionId}: using testimonial interview prompt (skipping search)`);

      // Dynamic context IS the primary system prompt in interview mode
      const finalMessages = [
        ...session.dynamicContext,
        ...session.messages
      ];

      session.llmTtftTime = Date.now();
      const finalResponse = await generateResponse({ messages: finalMessages });

      // Save, format, TTS, metrics handled below
      session.llmFinishTime = Date.now();
      session.messages.push({ role: "assistant", content: finalResponse });
      console.log(`[LLM RESPONSE] (${session.sessionId}): ${finalResponse}`);

      const speechOutput = formatForSpeech(finalResponse);

      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({ type: "state", value: "speaking" }));
        session.ws.send(JSON.stringify({ type: "transcript_assistant", text: finalResponse }));
      }
      await streamTTS(speechOutput, session, session.ws);

      // After AI finishes speaking in interview mode, go to listening for next user response
      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({ type: "state", value: "listening" }));
      }

      // Emit metrics
      if (session.ws && session.ws.readyState === 1) {
        const sttLatency = session.sttFinishTime - session.turnStartTime;
        const llmTtft = session.llmTtftTime ? (session.llmTtftTime - session.sttFinishTime) : 0;
        const llmTotal = session.llmFinishTime - session.sttFinishTime;
        const ttsLatency = session.ttsFirstChunkTime ? (session.ttsFirstChunkTime - session.llmFinishTime) : 0;
        const e2eLatency = (session.ttsFirstChunkTime || Date.now()) - session.turnStartTime;

        session.ws.send(JSON.stringify({
          type: "metrics",
          turnId: session.turnId,
          data: { sttLatencyMs: sttLatency, llmTtftMs: llmTtft, llmTotalMs: llmTotal, ttsLatencyMs: ttsLatency, e2eLatencyMs: e2eLatency, bargeIn: session.hasBargeIn }
        }));
        session.hasBargeIn = false;
      }

      session.isProcessingTurn = false;
      return; // Done — skip the generic voice assistant path
    }

    // ── GENERIC MODE: Original flow with search decision ──

    // 2. SEARCH DECISION (Call 1)
    const decisionPrompt = {
      role: "system",
      content: "Analyze the user query. If it requires real-time facts (weather, news, stocks) and specifies a subject or location, respond ONLY with valid JSON: { \"search\": true, \"query\": \"...\" }. If it is a general question, definition, or skip-able, respond { \"search\": false }."
    };

    // Inject Dynamic Context for Decision
    const messagesForDecision = [
      decisionPrompt,
      ...session.dynamicContext,
      ...session.messages
    ];
    console.log(`[MEMORY] Session ${session.sessionId}: sending ${messagesForDecision.length} messages to decision LLM`);

    const decisionResponse = await generateResponse({ messages: messagesForDecision });

    let decision = { search: false };
    try {
      decision = JSON.parse(decisionResponse);
    } catch (e) {
      console.log(`[SEARCH] Session ${session.sessionId}: decision parse failed, defaulting to skip`);
    }

    let searchContent = null;

    // 3. FINAL SEARCH GATE
    if (decision.search && shouldTriggerSearch(decision.query)) {
      console.log(`[SEARCH] Session ${session.sessionId}: triggered for query "${decision.query}"`);
      const results = await webSearch(decision.query);
      searchContent = JSON.stringify(results);
    } else {
      console.log(`[SEARCH] Session ${session.sessionId}: skipped (intent not met or decision false)`);
    }

    // 4. FINAL RESPONSE (Call 2)
    const mainSystemPrompt = {
      role: "system",
      content: `You are a voice assistant speaking to a human in real time. Your response will be spoken aloud using text-to-speech, not read on a screen.

Strict Rules:
- Do NOT use bullet points, numbered lists, markdown, or symbols.
- Speak in natural, conversational sentences. Prefer short sentences.
- Convert specific symbols to speech: 31°C becomes "thirty one degrees", 50% becomes "fifty percent".
- Keep responses concise, friendly, and human. No robotic phrasing.`
    };

    // Inject Dynamic Context for Final Response (Priority: System -> Dynamic -> History)
    const finalMessages = [
      mainSystemPrompt,
      ...session.dynamicContext,
      ...session.messages
    ];

    // Inject EPHEMERAL search results if available
    if (searchContent) {
      finalMessages.push({
        role: "system",
        content: `Grounded search results for current context: ${searchContent}`
      });
    }

    session.llmTtftTime = Date.now();
    const finalResponse = await generateResponse({ messages: finalMessages });

    // 5. FINALIZE: save only assistant content to history
    session.llmFinishTime = Date.now();
    session.messages.push({ role: "assistant", content: finalResponse });
    console.log(`[LLM RESPONSE] (${session.sessionId}): ${finalResponse}`);

    // Post-process for speech
    const speechOutput = formatForSpeech(finalResponse);

    // 6. STREAM TTS
    if (session.ws && session.ws.readyState === 1) {
      session.ws.send(JSON.stringify({ type: "state", value: "speaking" }));
      session.ws.send(JSON.stringify({ type: "transcript_assistant", text: finalResponse }));
    }
    await streamTTS(speechOutput, session, session.ws);

    // 7. EMIT METRICS
    if (session.ws && session.ws.readyState === 1) {
      const sttLatency = session.sttFinishTime - session.turnStartTime;
      const llmTtft = session.llmTtftTime ? (session.llmTtftTime - session.sttFinishTime) : 0;
      const llmTotal = session.llmFinishTime - session.sttFinishTime;
      const ttsLatency = session.ttsFirstChunkTime ? (session.ttsFirstChunkTime - session.llmFinishTime) : 0;
      const e2eLatency = (session.ttsFirstChunkTime || Date.now()) - session.turnStartTime;

      session.ws.send(JSON.stringify({
        type: "metrics",
        turnId: session.turnId,
        data: {
          sttLatencyMs: sttLatency,
          llmTtftMs: llmTtft,
          llmTotalMs: llmTotal,
          ttsLatencyMs: ttsLatency,
          e2eLatencyMs: e2eLatency,
          bargeIn: session.hasBargeIn
        }
      }));
      // Reset flags
      session.hasBargeIn = false;
    }

  } catch (err) {
    console.error("[TURN] Failed to process user turn:", err.message);
  } finally {
    session.isProcessingTurn = false;
  }
}

/**
 * WebSocket connection handler
 */
wss.on("connection", (ws) => {
  const session = sessionManager.createSession();
  session.ws = ws; // Store client WS for TTS streaming
  console.log(`[SERVER] New Session Created: ${session.sessionId}`);

  ws.send(
    JSON.stringify({
      type: "session_started",
      sessionId: session.sessionId,
    })
  );

  // Initialize Deepgram connection IMMEDIATELY
  session.sttSocket = createStreamingSTT(session);

  ws.on("message", async (data) => {
    // 1. Try to parse as JSON Control Message
    let message = null;
    try {
      const text = Buffer.isBuffer(data) ? data.toString() : data;
      // Only attempt parse if it looks like JSON (starts with {)
      if (typeof text === 'string' && text.trim().startsWith('{')) {
        message = JSON.parse(text);
      }
    } catch (e) {
      // Not JSON, fall through to audio
    }

    if (message && message.type) {
      // ── Handle JSON Messages ──
      console.log(`[WS] Received JSON message: ${message.type}`);

      if (message.type === "context_update") {
        const content = message.payload?.content;
        if (!content || typeof content !== "string" || !content.trim()) {
          console.log(`[CONTEXT] Session ${session.sessionId}: update ignored (invalid payload)`);
          return;
        }

        // Atomic Replace-by-Default
        session.dynamicContext = [{ role: "system", content: content.trim() }];
        session.contextVersion++;

        console.log(`[CONTEXT] Session ${session.sessionId}: updated (v${session.contextVersion}) via WS. Content length: ${content.length}`);
      }

      if (message.type === "debug_input") {
        session.finalTranscript = message.text || "";
        finalizeTurn(session);
      }

      if (message.type === "playback_complete") {
        console.log(`[TTS] Client finished playback (${session.sessionId})`);
        session.isSpeakingTTS = false;
        // During interview: go to listening (waiting for next user response)
        // Outside interview: go to idle
        if (ws.readyState === 1) {
          const nextState = session.isInterviewActive ? "listening" : "idle";
          ws.send(JSON.stringify({ type: "state", value: nextState }));
        }
      }

      // ── Testimonial Interview: Start ──
      if (message.type === "start_interview") {
        if (session.isInterviewActive) {
          console.log(`[INTERVIEW] Ignoring duplicate start_interview (${session.sessionId})`);
          return;
        }

        session.isInterviewActive = true;
        session.turnStartTime = Date.now();
        console.log(`[INTERVIEW] Starting interview (${session.sessionId})`);

        // Log the current context state
        console.log(`[INTERVIEW] Current dynamicContext length: ${session.dynamicContext.length}`);
        if (session.dynamicContext.length > 0) {
          console.log(`[INTERVIEW] Context preview: ${session.dynamicContext[0].content.substring(0, 50)}...`);
        } else {
          console.warn(`[INTERVIEW] WARNING: No dynamic context set! Using fallback.`);
          // Auto-fix: Inject default if missing
          session.dynamicContext = [{
            role: "system",
            content: "IMPORTANT: You are a testimonial interviewer. Ask the user about their experience with the business. Be warm and conversational. Do not use lists."
          }];
        }

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "state", value: "thinking" }));
        }

        session.finalTranscript = "Hello, I'm ready to share my testimonial.";

        await new Promise(resolve => setTimeout(resolve, 300));
        await handleUserTurn(session);
      }

      // ── Testimonial Interview: End ──
      if (message.type === "end_interview") {
        if (!session.isInterviewActive) {
          console.log(`[INTERVIEW] Ignoring end_interview (not active) (${session.sessionId})`);
          return;
        }

        session.isInterviewActive = false;
        console.log(`[INTERVIEW] Ending interview (${session.sessionId})`);

        session.ttsRequestId += 1;
        if (session.ttsSocket) {
          try { session.ttsSocket.close(); } catch (e) { }
          session.ttsSocket = null;
        }
        session.isSpeakingTTS = false;

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "state", value: "speaking" }));
        }
        await streamTTS(
          "Thank you so much for sharing your testimonial. Your feedback is really valuable!",
          session,
          ws
        );

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "interview_end" }));
        }
      }

      return; // Handled as JSON
    }

    // 2. Handle Binary Audio Data
    session.lastAudioTimestamp = Date.now();

    // Convert to Float32Array for Noise Suppressor & VAD
    let floatSamples;
    if (Buffer.isBuffer(data)) {
      floatSamples = new Float32Array(data.length / 2);
      for (let i = 0; i < floatSamples.length; i++) {
        floatSamples[i] = data.readInt16LE(i * 2) / 32768.0;
      }
    } else {
      floatSamples = data;
    }

    // Apply Noise Suppression (updates noise floor state)
    const cleanSamples = session.noise.suppress(floatSamples);

    // Pass CLEAN samples to VAD
    const vadStatus = session.vad.process(cleanSamples);

    // Stream ALL audio to Deepgram if socket is open (Always-On)
    if (session.sttSocket && session.sttSocket.readyState === WebSocket.OPEN) {
      session.sttSocket.send(data);
    }

    if (vadStatus === "speech_start") {
      // Cancel pending silence debounce
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
        session.debounceTimer = null;
        console.log(`[VAD] Debounce: silence interruption cancelled (${session.sessionId})`);
      }

      if (!session.isSpeaking) {
        session.isSpeaking = true;
        console.log(`[TURN] Speech started (${session.sessionId})`);

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "state", value: "listening" }));
        }

        session.ttsRequestId += 1;
        session.isSpeakingTTS = false;

        if (session.ttsSocket) {
          try {
            session.ttsSocket.close();
          } catch (e) { }
          session.ttsSocket = null;
        }

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "barge_in" }));
        }

        session.hasBargeIn = true;
        console.log(`[TTS] Hard cancel triggered (requestId=${session.ttsRequestId})`);

        // Reset buffers for clean turn start
        session.finalTranscript = "";
        session.interimTranscript = "";
      }
    }

    if (vadStatus === "speech_end" && session.isSpeaking) {
      // Debounce: Wait 1 second of silence before finalizing
      if (session.debounceTimer) clearTimeout(session.debounceTimer);

      console.log(`[VAD] Speech end detected. Waiting 2500ms... (${session.sessionId})`);
      session.debounceTimer = setTimeout(() => {
        session.debounceTimer = null;
        finalizeTurn(session);
      }, 2500);
    }
  });

  ws.on("close", () => {
    if (session.sttSocket) session.sttSocket.close();
    sessionManager.deleteSession(session.sessionId);
    console.log(`Session closed: ${session.sessionId}`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    if (session.sttSocket) session.sttSocket.close();
    sessionManager.deleteSession(session.sessionId);
  });
});

async function finalizeTurn(session) {
  // Guard: skip if already processing a turn (prevents concurrent invocations
  // from VAD speech_end + heartbeat interval firing simultaneously)
  if (session.isProcessingTurn) {
    console.log(`[TURN] Skipping finalizeTurn — already processing (${session.sessionId})`);
    return;
  }

  // Normal VAD buffer flush logic for real audio
  if (session.isSpeaking) {
    session.isSpeaking = false;
    session.turnStartTime = Date.now();
    console.log(`[TURN] Speech ended (${session.sessionId})`);

    // Immediately tell the UI we are thinking to bridge the gap
    if (session.ws && session.ws.readyState === 1) {
      session.ws.send(JSON.stringify({ type: "state", value: "thinking" }));
    }

    // Small delay to ensure Deepgram's final results are processed
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  await handleUserTurn(session);
}

// Start Server
server.listen(PORT, () => {
  // console.log(`Voice Agent Server running on http://localhost:${PORT}`); -- logged above
});

setInterval(() => {
  const now = Date.now();
  for (const session of sessionManager.getAllSessions()) {
    // Skip if already processing a turn (prevents heartbeat from
    // firing finalizeTurn during active LLM/TTS processing)
    if (session.isProcessingTurn) continue;
    if (
      session.isSpeaking &&
      now - session.lastAudioTimestamp > TURN_END_SILENCE_MS
    ) {
      console.log(`[TURN] Heartbeat fallback end (${session.sessionId})`);
      finalizeTurn(session);
    }
  }
}, TURN_CHECK_INTERVAL_MS);
const https = require("https");
// Self-ping to keep Render instance alive (every 5 minutes)
const RENDER_EXTERNAL_URL = "https://infera-test.onrender.com/health";
setInterval(() => {
  https.get(RENDER_EXTERNAL_URL, (res) => {
    console.log(`[SELF-PING] Status: ${res.statusCode}`);
  }).on("error", (err) => {
    console.log(`[SELF-PING] Failed: ${err.message}`);
  });
}, 300000); // 5 minutes (300,000 ms)
