require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const http = require("http");
const WebSocket = require("ws");
const { execSync } = require('child_process');
const SessionManager = require("./sessions/SessionManager");
const { createStreamingSTT } = require("./stt/sttService");
const { generateResponse } = require("./llm/llmService");
const { webSearch } = require("./tools/webSearch");
const { streamTTS } = require("./tts/ttsService");
const { formatForSpeech } = require("./utils/speechFormatter");
const { analyzeHighlights, createReel } = require("./video/reelService");
const vizardService = require("./video/vizardService");

const PORT = 8080;
console.log("!!! INFERA BACKEND LOADED - VERSION 9.0 - ASYNC ENGINE !!!");
const TURN_END_SILENCE_MS = 800;
const TURN_CHECK_INTERVAL_MS = 200;

// FOR DEVELOPMENT: Automatically clear port 8080 if it's stuck
try {
  const currentPid = process.pid.toString();
  const pids = execSync(`lsof -t -i:${PORT}`).toString().trim().split('\n');
  pids.forEach(pid => {
    if (pid && pid !== currentPid) {
      console.log(`[SERVER] Cleaning up stale process ${pid} on port ${PORT}...`);
      try { execSync(`kill -9 ${pid}`); } catch (e) { }
    }
  });
} catch (e) {
  // ignore
}

// Setup Express
const app = express();
app.use(cors());
app.use(express.json());

// Ensure directories exist
const uploadDir = path.join(__dirname, "uploads");
const reelDir = path.join(__dirname, "public", "reels");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(reelDir)) fs.mkdirSync(reelDir, { recursive: true });

// Serve static files (reels)
app.use("/reels", express.static(reelDir));

// Setup Multer for video uploads
const upload = multer({ dest: "uploads/" });

// ── Express Routes ──

// Health Check
app.get("/health", (req, res) => res.send("OK"));

// Admin API: Context Update
app.post("/admin/context", (req, res) => {
  const { sessionId, content } = req.body;
  if (!sessionId || !content) {
    return res.status(400).json({ error: "Missing sessionId or content" });
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  session.dynamicContext = [{ role: "system", content: content.trim() }];
  session.contextVersion++;
  console.log(`[CONTEXT] Session ${session.sessionId}: updated (v${session.contextVersion}) via ADMIN API`);
  res.json({ success: true, version: session.contextVersion });
});

/**
 * Viral Reel Generation API
 */
app.post("/api/generate-reel", upload.single("video"), async (req, res) => {
  try {
    const { transcript } = req.body;
    const videoFile = req.file;

    if (!videoFile || !transcript) {
      return res.status(400).json({ error: "Missing video file or transcript" });
    }

    console.log(`[REEL] AI Automation requested. File: ${videoFile.path}`);

    if (!process.env.VIZARD_API_KEY) {
      console.log("[REEL] VIZARD_API_KEY missing. Falling back to manual cinematic FFmpeg for now.");
      // 1. Analyze highlights
      const highlights = await analyzeHighlights(transcript);

      // 2. Process Video
      const outputFilename = `reel-${Date.now()}.mp4`;
      const outputPath = path.join(reelDir, outputFilename);
      const inputPath = path.join(__dirname, videoFile.path);

      await createReel(inputPath, outputPath, highlights);

      // 3. Cleanup input
      fs.unlinkSync(inputPath);

      // 4. Return URL
      const reelUrl = `${req.protocol}://${req.get("host")}/reels/${outputFilename}`;
      return res.json({ success: true, reelUrl, hookText: highlights.hookText, mode: 'fallback_ffmpeg' });
    }

    // ── Vizard.ai Logic ──
    const inputPath = path.join(__dirname, videoFile.path);

    // We start the background process, but since the user wants to see it, 
    // we'll simulate the "High Quality" result. 
    // In a real prod environment, we'd use webhooks.

    const project = await vizardService.uploadToVizard(inputPath);
    const bestClip = await vizardService.pollForResults(project.projectId);

    // Cleanup input
    fs.unlinkSync(inputPath);

    res.json({
      success: true,
      reelUrl: bestClip.videoUrl,
      hookText: bestClip.title,
      mode: 'ai_automation'
    });

  } catch (error) {
    console.error(`[REEL] Error:`, error);
    res.status(500).json({ error: "Failed to generate reel", details: error.message });
  }
});

// 2. Create HTTP Server for shared use
// Setup WebSocket Server & Session Manager
const sessionManager = new SessionManager();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

console.log(`Voice Agent Server (Express + WS) running on :${PORT}`);

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
  const transcript = session.finalTranscript.trim();

  // Reset transcript buffers for next turn immediately to avoid leakage
  session.finalTranscript = "";
  session.interimTranscript = "";

  if (!transcript) {
    console.log(`[USER SAID] (${session.sessionId}): <empty> (Skipping turn)`);
    // Authority: Return to idle if nothing was said
    if (session.ws && session.ws.readyState === 1) {
      session.ws.send(JSON.stringify({ type: "state", value: "idle" }));
    }
    return;
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
      let finalResponse = await generateResponse({ messages: finalMessages });

      // Save, format, TTS, metrics handled below
      let isInterviewComplete = false;
      if (finalResponse.includes("<END_INTERVIEW>")) {
        isInterviewComplete = true;
        finalResponse = finalResponse.replace("<END_INTERVIEW>", "").trim();
      }

      // Save, format, TTS, metrics handled below
      session.llmFinishTime = Date.now();
      session.messages.push({ role: "assistant", content: finalResponse });
      console.log(`[LLM RESPONSE] (${session.sessionId}): ${finalResponse}`);

      const speechOutput = formatForSpeech(finalResponse);

      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({ type: "state", value: "speaking" }));
        session.ws.send(JSON.stringify({ type: "transcript_assistant", text: finalResponse }));
      }

      // Wait for TTS to finish streaming
      await streamTTS(speechOutput, session, session.ws);

      // If interview is complete, send the signal to frontend
      if (isInterviewComplete && session.ws && session.ws.readyState === 1) {
        console.log(`[INTERVIEW] Auto-terminating session ${session.sessionId}`);
        session.ws.send(JSON.stringify({ type: "interview_end" }));
        session.isInterviewActive = false;
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
        // Authority: Now that audio is done, we can go idle
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "state", value: "idle" }));
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
    const vadStatus = session.vad.process(data);

    // Stream ALL audio to Deepgram if socket is open (Always-On)
    if (session.sttSocket && session.sttSocket.readyState === WebSocket.OPEN) {
      session.sttSocket.send(data);
    }

    if (vadStatus === "speech_start" && !session.isSpeaking) {
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

    if (vadStatus === "speech_end" && session.isSpeaking) {
      finalizeTurn(session);
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
  // If simulated by debug_input, force isSpeaking to treat as turn end
  // But normally isSpeaking is imperative.
  // For debug logic, we just call handleUserTurn directly.

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
