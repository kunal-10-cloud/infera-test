"use client";

import { useState, useCallback, useRef } from 'react';
import { VoiceWebSocket, AgentState, TranscriptMessage, WebSocketMessage } from '@/lib/websocket';
import { startAudio } from '@/lib/audioManager';
import { TTSPlayer } from '@/lib/ttsPlayer';

interface UseVoiceAgentOptions {
    onInterviewEnd?: () => void;
}

export function useVoiceAgent(options: UseVoiceAgentOptions = {}) {
    const [state, setState] = useState<AgentState>("idle");
    const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
    const [metrics, setMetrics] = useState<any[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);

    const wsRef = useRef<VoiceWebSocket | null>(null);
    const ttsPlayerRef = useRef<TTSPlayer | null>(null);
    const stopAudioRef = useRef<(() => void) | null>(null);
    const onInterviewEndRef = useRef(options.onInterviewEnd);

    // Keep callback ref fresh
    onInterviewEndRef.current = options.onInterviewEnd;

    const handleMessage = useCallback((msg: WebSocketMessage) => {
        switch (msg.type) {
            case "state":
                if (msg.value) {
                    setState(msg.value);
                    if (msg.value === "listening" || msg.value === "thinking") {
                        ttsPlayerRef.current?.stopAll();
                    }
                }
                break;

            case "transcript_user":
                if (msg.text) {
                    setTranscript(prev => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === "user" && (last as any).isInterim) {
                            return [...prev.slice(0, -1), { role: "user", text: msg.text!, isInterim: msg.isInterim } as any];
                        }
                        return [...prev, { role: "user", text: msg.text!, isInterim: msg.isInterim } as any];
                    });
                }
                break;

            case "transcript_assistant":
                if (msg.text) {
                    setTranscript(prev => {
                        const last = prev[prev.length - 1];
                        if (last && last.role === "assistant") {
                            return [...prev.slice(0, -1), { role: "assistant", text: msg.text! }];
                        }
                        return [...prev, { role: "assistant", text: msg.text! }];
                    });
                }
                break;

            case "metrics":
                if (msg.data && msg.turnId !== undefined) {
                    setMetrics(prev => [{ turnId: msg.turnId, ...msg.data }, ...prev].slice(0, 10));
                }
                break;

            case "barge_in":
                ttsPlayerRef.current?.stopAll();
                setState("listening");
                break;

            case "tts_audio_full":
                if (msg.payload) {
                    ttsPlayerRef.current?.handleFullAudio(msg.payload);
                }
                break;

            case "tts_complete":
                ttsPlayerRef.current?.markBackendDone();
                break;

            case "session_started":
                console.log("[SESSION] Started:", msg.sessionId);
                setSessionId(msg.sessionId || null);
                break;

            case "interview_end":
                console.log("[INTERVIEW] Backend signaled interview end");
                onInterviewEndRef.current?.();
                break;
        }
    }, []);

    const connect = useCallback(async () => {
        if (wsRef.current) return;

        const BACKEND_URL = process.env.NEXT_PUBLIC_WS_URL || "wss://infera-test.onrender.com";
        console.log(`[WS] Connecting to: ${BACKEND_URL}`);

        const ws = new VoiceWebSocket(BACKEND_URL, handleMessage);
        await ws.connect(); // Wait for WS to actually open
        wsRef.current = ws;

        // Initialize TTS Player
        const player = new TTSPlayer();
        await player.init();
        player.onComplete = () => {
            if (wsRef.current) {
                wsRef.current.send({ type: "playback_complete" });
            }
        };
        ttsPlayerRef.current = player;

        // Start microphone streaming
        const { stop } = await startAudio((pcm16) => {
            if (wsRef.current) {
                wsRef.current.sendRaw(pcm16);
            }
        });

        stopAudioRef.current = stop;
        setIsConnected(true);
        console.log("[VOICE AGENT] Connected and audio activated");
    }, [handleMessage]);

    const sendContextUpdate = useCallback((content: string) => {
        if (wsRef.current) {
            wsRef.current.send({
                type: "context_update",
                payload: { content }
            });
            console.log("[VOICE AGENT] Context update sent");
        }
    }, []);

    const sendStartInterview = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.send({ type: "start_interview" });
            console.log("[VOICE AGENT] Start interview sent");
        }
    }, []);

    const sendEndInterview = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.send({ type: "end_interview" });
            console.log("[VOICE AGENT] End interview sent");
        }
    }, []);

    const disconnect = useCallback(() => {
        if (stopAudioRef.current) {
            stopAudioRef.current();
            stopAudioRef.current = null;
        }
        if (ttsPlayerRef.current) {
            ttsPlayerRef.current.stopAll();
            ttsPlayerRef.current = null;
        }
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setIsConnected(false);
        setState("idle");
        console.log("[VOICE AGENT] Disconnected");
    }, []);

    return {
        state,
        transcript,
        metrics,
        isConnected,
        sessionId,
        connect,
        disconnect,
        sendContextUpdate,
        sendStartInterview,
        sendEndInterview,
    };
}
