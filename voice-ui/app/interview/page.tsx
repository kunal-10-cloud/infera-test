"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import Image from 'next/image';
import { useVoiceAgent } from '@/hooks/useVoiceAgent';
import { useMediaRecorder } from '@/hooks/useMediaRecorder';
import { useInterviewTimer } from '@/hooks/useInterviewTimer';

const INTERVIEW_DURATION_SECONDS = 120; // 2 minutes

export default function InterviewPage() {
    const router = useRouter();
    const [prompt, setPrompt] = useState<string | null>(null);
    const [interviewStarted, setInterviewStarted] = useState(false);
    const [isEnding, setIsEnding] = useState(false);
    const hasInitializedRef = useRef(false);
    const isEndingRef = useRef(false);

    const { videoRef, isRecording, startRecording, stopRecording } = useMediaRecorder();

    // ── Voice Agent with interview_end callback ──
    const {
        state: agentState,
        transcript,
        isConnected,
        connect,
        disconnect,
        sendContextUpdate,
        sendStartInterview,
        sendEndInterview,
    } = useVoiceAgent({
        onInterviewEnd: () => {
            console.log("[INTERVIEW] Backend signaled interview_end → ending...");
            endInterviewRef.current();
        },
    });

    // ── End Interview (called by timer expiry OR backend signal) ──
    const endInterview = useCallback(async () => {
        if (isEndingRef.current) return;
        isEndingRef.current = true;
        setIsEnding(true);
        console.log("[INTERVIEW] Ending interview...");

        // Stop recording immediately
        await stopRecording();

        // Wait for the "thank you" TTS to finish playing, then redirect
        setTimeout(() => {
            router.push('/playback');
        }, 5000);
    }, [stopRecording, router]);

    const endInterviewRef = useRef(endInterview);
    
    // Update ref when endInterview changes
    useEffect(() => {
        endInterviewRef.current = endInterview;
    }, [endInterview]);

    // ── Timer Expiry Handler ──
    const handleTimerExpire = useCallback(() => {
        console.log("[TIMER] 2-minute interview time expired");
        // Tell backend to wrap up (sends closing TTS + interview_end signal)
        sendEndInterview();

        // FALLBACK: If backend doesn't respond within 8s, force redirect
        setTimeout(() => {
            if (!isEndingRef.current) {
                console.log("[TIMER] Fallback: forcing end after timeout");
                endInterviewRef.current();
            }
        }, 8000);
    }, [sendEndInterview]);

    const { formattedTime, isExpired, start: startTimer } = useInterviewTimer({
        durationSeconds: INTERVIEW_DURATION_SECONDS,
        onExpire: handleTimerExpire,
    });

    // ── Step 1: Safety guard — check for prompt ──
    useEffect(() => {
        const stored = sessionStorage.getItem('testimonial_prompt');
        if (!stored) {
            router.replace('/');
            return;
        }
        setPrompt(stored);
    }, [router]);

    // ── Step 2: Connect voice agent once prompt is loaded ──
    useEffect(() => {
        if (!prompt || hasInitializedRef.current) return;
        hasInitializedRef.current = true;

        (async () => {
            try {
                await connect();
                console.log("[INTERVIEW] Voice agent connected, WS is open");
            } catch (err) {
                console.error("[INTERVIEW] Failed to connect:", err);
            }
        })();
    }, [prompt, connect]);

    // ── Step 3: Once connected, inject context → start recording → start interview → start timer ──
    useEffect(() => {
        if (!isConnected || interviewStarted || !prompt) return;

        (async () => {
            // 3a. Inject the testimonial interview context
            const contextPrompt = `IMPORTANT: You are a TESTIMONIAL INTERVIEWER. Your goal is to get a short, crisp video testimonial (max 3 exchanges).
You are interviewing a customer about: "${prompt}"

YOUR FLOW (Strictly follow this order):
1. **First Question**: Ask about their overall experience. What did they like? What did they dislike?
2. **Analyze Answer**:
   - IF POSITIVE: Ask if they have anything else to add.
   - IF NEGATIVE/MIXED: Be apologetic and ask for their top recommendation to improve.
   - IF they already covered everything: Move significantly to closing.
3. **Closing**: Thank them warmly for their feedback.
   - **CRITICAL**: Append the tag <END_INTERVIEW> to the end of your final thank-you message.

RULES:
- ONE question at a time.
- Keep responses SHORT (1 sentence max).
- NO lists or bullet points.
- If the user says "no" to adding more, seeking recommendations, or is done: Say thank you and append <END_INTERVIEW>.
- DO NOT say <END_INTERVIEW> unless you are absolutely finished.`;

            sendContextUpdate(contextPrompt);
            console.log("[INTERVIEW] Context injected");

            // 3b. Small delay to ensure context is processed
            await new Promise(r => setTimeout(r, 600));

            // 3c. Start FULL SESSION recording (Screen + Audio)
            // Note: browser will prompt user to select screen
            alert("Please select THIS TAB and enable 'Share Audio' to record the interview.");
            await startRecording();
            console.log("[INTERVIEW] Recording started");

            // 3d. Trigger the AI to ask the first question
            sendStartInterview();
            console.log("[INTERVIEW] AI interview started");

            // 3e. Start the 2-minute countdown
            startTimer();

            setInterviewStarted(true);
        })();
    }, [isConnected, interviewStarted, prompt, sendContextUpdate, sendStartInterview, startRecording, startTimer]);

    // ── Cleanup on unmount ──
    useEffect(() => {
        return () => {
            disconnect();
        };
    }, [disconnect]);

    // Loading state while checking for prompt
    if (!prompt) {
        return (
            <div className="min-h-screen bg-[#0a0a0b] flex items-center justify-center">
                <div className="animate-spin w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <main className="h-screen w-full bg-[#0a0a0b] text-white overflow-hidden flex flex-col">
            {/* ── Top Bar ── */}
            <div className="flex-shrink-0 h-14 border-b border-white/10 flex items-center justify-between px-6 bg-black/40 backdrop-blur-xl">
                <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full animate-pulse ${isEnding ? 'bg-red-400' :
                        agentState === 'listening' ? 'bg-blue-500' :
                            agentState === 'thinking' ? 'bg-purple-500' :
                                agentState === 'speaking' ? 'bg-emerald-500' :
                                    'bg-slate-400'
                        }`} />
                    <span className="text-xs uppercase tracking-[0.15em] text-slate-400 font-semibold">
                        {isEnding ? 'Wrapping up...' :
                            agentState === 'listening' ? 'Listening to you' :
                                agentState === 'thinking' ? 'Preparing question' :
                                    agentState === 'speaking' ? 'AI Speaking' : 'Connecting...'}
                    </span>
                </div>

                {/* Timer */}
                <div className={`flex items-center gap-2 px-4 py-1.5 rounded-full border ${isExpired || isEnding ? 'border-red-500/30 bg-red-500/10' : 'border-white/10 bg-white/5'
                    }`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${isEnding ? 'bg-red-500' : isRecording ? 'bg-red-500 animate-pulse' : 'bg-slate-500'
                        }`} />
                    <span className={`text-sm font-mono font-bold tracking-wider ${isExpired || isEnding ? 'text-red-400' : 'text-white'
                        }`}>
                        {formattedTime}
                    </span>
                </div>

                {/* Recording Badge */}
                <div className="flex items-center gap-2">
                    {isRecording && (
                        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/15 border border-red-500/30">
                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-[10px] uppercase tracking-wide font-bold text-red-400">REC</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Split Screen ── */}
            <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                {/* Left Half – AI Avatar */}
                <div className="flex-1 flex flex-col items-center justify-center relative bg-gradient-to-b from-[#0a0a0b] to-[#0d0d12]">
                    {/* Ambient glow */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div className={`w-64 h-64 rounded-full blur-[100px] transition-colors duration-1000 ${agentState === 'listening' ? 'bg-blue-600/20' :
                            agentState === 'thinking' ? 'bg-purple-600/20' :
                                agentState === 'speaking' ? 'bg-emerald-600/20' :
                                    'bg-slate-600/10'
                            }`} />
                    </div>

                    {/* Animated Orb with Character */}
                    <motion.div
                        animate={{
                            scale: agentState === 'speaking' ? [1, 1.15, 1] :
                                agentState === 'thinking' ? [1, 1.05, 1] :
                                    agentState === 'listening' ? [1, 1.08, 1] : 1,
                        }}
                        transition={{
                            duration: agentState === 'speaking' ? 0.6 :
                                agentState === 'thinking' ? 1.5 :
                                    agentState === 'listening' ? 2 : 0,
                            repeat: Infinity,
                            ease: "easeInOut",
                        }}
                        className="relative z-10"
                    >
                        <div className={`w-32 h-32 md:w-40 md:h-40 rounded-full transition-all duration-500 overflow-hidden ${agentState === 'listening' ? 'bg-gradient-to-br from-blue-500 to-blue-700 shadow-[0_0_60px_rgba(59,130,246,0.4)]' :
                            agentState === 'thinking' ? 'bg-gradient-to-br from-purple-500 to-purple-700 shadow-[0_0_60px_rgba(168,85,247,0.4)]' :
                                agentState === 'speaking' ? 'bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_60px_rgba(52,211,153,0.4)]' :
                                    'bg-gradient-to-br from-slate-600 to-slate-800 shadow-[0_0_30px_rgba(100,116,139,0.2)]'
                            }`}>
                            {/* Character Image */}
                            <Image 
                                src="/avatar.png" 
                                alt="AI Character"
                                fill
                                className="object-cover rounded-full"
                            />
                            {/* Overlay gradient for state effects */}
                            <div className={`absolute inset-0 rounded-full transition-all duration-500 ${agentState === 'listening' ? 'bg-blue-500/20' :
                                agentState === 'thinking' ? 'bg-purple-500/20' :
                                    agentState === 'speaking' ? 'bg-emerald-500/20' :
                                        'bg-slate-800/30'
                                }`} />
                        </div>
                    </motion.div>

                    <p className="mt-6 text-xs text-slate-500 uppercase tracking-[0.2em] font-semibold">
                        AI Interviewer
                    </p>

                    {/* Transcript */}
                    <div className="absolute bottom-0 left-0 right-0 max-h-[40%] overflow-y-auto px-6 py-4 bg-gradient-to-t from-[#0a0a0b] via-[#0a0a0b]/90 to-transparent">
                        <div className="space-y-3 max-w-md mx-auto">
                            {transcript.slice(-6).map((msg, i) => (
                                <div key={i} className={`text-sm leading-relaxed ${msg.role === 'assistant' ? 'text-emerald-300/80' : 'text-blue-300/80'
                                    }`}>
                                    <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-2 font-semibold">
                                        {msg.role === 'assistant' ? 'AI' : 'You'}
                                    </span>
                                    {msg.text}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Right Half – User Video */}
                <div className="flex-1 relative bg-[#0d0d12] border-l border-white/5">
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                        style={{ transform: 'scaleX(-1)' }}
                    />

                    {/* Placeholder when no video */}
                    {!isRecording && (
                        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d12]">
                            <div className="text-center">
                                <div className="w-16 h-16 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-4">
                                    <svg className="w-8 h-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                </div>
                                <p className="text-sm text-slate-500">Starting camera...</p>
                            </div>
                        </div>
                    )}

                    {/* Corner recording indicator */}
                    {isRecording && (
                        <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm border border-white/10">
                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-[10px] uppercase tracking-wider font-bold text-white/80">Recording</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Ending Overlay ── */}
            {isEnding && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 z-50 flex items-center justify-center bg-[#0a0a0b]/90 backdrop-blur-sm"
                >
                    <div className="text-center">
                        <div className="w-12 h-12 mx-auto mb-4 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
                        <p className="text-lg text-slate-300">Saving your testimonial...</p>
                        <p className="text-sm text-slate-500 mt-2">Redirecting to playback...</p>
                    </div>
                </motion.div>
            )}
        </main>
    );
}
