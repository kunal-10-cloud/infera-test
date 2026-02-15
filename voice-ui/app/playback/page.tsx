"use client";

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';

type FlowStage = 'preview' | 'generating' | 'success' | 'error';

export default function PlaybackPage() {
    const router = useRouter();
    const [stage, setStage] = useState<FlowStage>('preview');
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const [reelUrl, setReelUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [statusText, setStatusText] = useState("AI is analyzing your tone...");
    const [hookText, setHookText] = useState<string | null>(null);

    useEffect(() => {
        const url = sessionStorage.getItem('testimonial_video_url');
        if (url) {
            setVideoUrl(url);
        } else {
            router.replace('/');
        }
    }, [router]);

    const generateViralReel = async () => {
        if (!videoUrl) return;
        setStage('generating');
        setError(null);
        setStatusText("Uploading to AI cloud...");

        try {
            // 1. Get blob from URL
            const response = await fetch(videoUrl);
            const blob = await response.blob();

            // 2. Get transcript
            const storedTranscript = sessionStorage.getItem('last_interview_transcript');
            if (!storedTranscript) {
                throw new Error("Interview transcript not found. Please re-record your session.");
            }
            const transcriptText = JSON.parse(storedTranscript).map((m: any) => `${m.role}: ${m.text}`).join('\n');

            // 3. Prepare Form Data
            const formData = new FormData();
            formData.append('video', blob, 'video.webm');
            formData.append('transcript', transcriptText);

            // Simulate AI steps for UX
            const statusInt1 = setTimeout(() => setStatusText("Identifying viral moments..."), 3000);
            const statusInt2 = setTimeout(() => setStatusText("Auto-reframing vertical view..."), 7000);
            const statusInt3 = setTimeout(() => setStatusText("Generating high-energy captions..."), 12000);

            // 4. Call API
            const isLocal = typeof window !== 'undefined' &&
                (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

            let apiBase = process.env.NEXT_PUBLIC_WS_URL?.replace('wss://', 'https://').replace('ws://', 'http://');
            if (isLocal || !apiBase) {
                apiBase = "http://localhost:8080";
            }

            console.log(`[REEL] Calling API: ${apiBase}/api/generate-reel`);

            const res = await fetch(`${apiBase}/api/generate-reel`, {
                method: 'POST',
                body: formData,
            });

            clearTimeout(statusInt1);
            clearTimeout(statusInt2);
            clearTimeout(statusInt3);

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.details || "Failed to process reel");
            }

            const data = await res.json();
            if (data.success) {
                setReelUrl(data.reelUrl);
                setHookText(data.hookText);
                setStage('success');
            } else {
                throw new Error(data.error || "Unknown error during reel generation");
            }
        } catch (err: any) {
            console.error("[REEL] Generation error:", err);
            setError(err.message || "Something went wrong. Please try again.");
            setStage('error');
        }
    };

    const containerVariants = {
        initial: { opacity: 0, scale: 0.95 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 1.05 }
    };

    return (
        <main className="min-h-screen w-full bg-[#0a0a0b] text-white flex flex-col items-center justify-center p-6 relative overflow-hidden">
            {/* Ambient Background Glows */}
            <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-violet-600/10 rounded-full blur-[120px] pointer-events-none" />
            <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[120px] pointer-events-none" />

            <AnimatePresence mode="wait">
                {/* ── STAGE: PREVIEW ── */}
                {stage === 'preview' && (
                    <motion.div
                        key="preview"
                        variants={containerVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="max-w-xl w-full text-center space-y-8 z-10"
                    >
                        <div className="space-y-2">
                            <h1 className="text-3xl md:text-4xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
                                Testimonial Captured! 🎬
                            </h1>
                            <p className="text-slate-400">Review your session and turn it into a viral masterpiece.</p>
                        </div>

                        <div className="rounded-3xl overflow-hidden border border-white/10 shadow-2xl bg-black/40 backdrop-blur-sm p-2">
                            <video src={videoUrl || ''} controls className="w-full aspect-video rounded-2xl object-cover" />
                        </div>

                        <div className="flex flex-col gap-4">
                            <button
                                onClick={generateViralReel}
                                className="group relative w-full py-5 px-8 rounded-2xl font-bold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 transition-all duration-300 shadow-[0_0_40px_rgba(139,92,246,0.3)] flex items-center justify-center gap-3 active:scale-[0.98]"
                            >
                                <span className="text-lg">✨ Clip it into a Viral Reel</span>
                                <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                            </button>

                            <button
                                onClick={() => router.push('/')}
                                className="text-slate-500 hover:text-white text-sm font-medium transition-colors"
                            >
                                Re-record Testimonial
                            </button>
                        </div>
                    </motion.div>
                )}

                {/* ── STAGE: GENERATING ── */}
                {stage === 'generating' && (
                    <motion.div
                        key="generating"
                        variants={containerVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="max-w-md w-full text-center space-y-10 z-10"
                    >
                        <div className="relative">
                            <div className="w-24 h-24 mx-auto relative">
                                <div className="absolute inset-0 rounded-full border-2 border-violet-500/20" />
                                <div className="absolute inset-0 rounded-full border-t-2 border-violet-500 animate-spin" />
                                <div className="absolute inset-4 rounded-full border-b-2 border-indigo-500 animate-[spin_2s_linear_infinite_reverse]" />
                            </div>
                        </div>

                        <div className="space-y-4">
                            <h2 className="text-2xl font-bold tracking-wide">Generating your reel</h2>
                            <p className="text-violet-400 font-medium animate-pulse tracking-wide uppercase text-xs">
                                {statusText}
                            </p>
                        </div>

                        <div className="bg-white/5 border border-white/10 rounded-2xl p-6 text-left space-y-3">
                            <div className="flex items-center gap-3 text-xs text-slate-400">
                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                                <span>AI analyzing viral hooks</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-slate-400">
                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                                <span>Auto-reframing vertical 9:16</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs">
                                <div className="w-4 h-4 rounded-full border-2 border-slate-700 border-t-violet-400 animate-spin" />
                                <span className="text-slate-200">Generating high-fidelity captions</span>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* ── STAGE: SUCCESS ── */}
                {stage === 'success' && (
                    <motion.div
                        key="success"
                        variants={containerVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="max-w-4xl w-full flex flex-col md:flex-row gap-10 items-center justify-center z-10"
                    >
                        {/* Reel Preview */}
                        <div className="w-72 flex-shrink-0 relative group">
                            <div className="absolute -inset-1 bg-gradient-to-b from-violet-600 to-indigo-600 rounded-[2rem] blur opacity-25 group-hover:opacity-40 transition duration-1000 group-hover:duration-200" />
                            <div className="relative rounded-[2rem] overflow-hidden border-2 border-white/10 bg-black aspect-[9/16] shadow-2xl">
                                <video
                                    src={reelUrl || ''}
                                    controls
                                    autoPlay
                                    loop
                                    className="w-full h-full object-cover"
                                />
                            </div>
                        </div>

                        {/* Success Content */}
                        <div className="flex-1 text-center md:text-left space-y-8 max-w-sm">
                            <div className="space-y-3">
                                <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/30 rounded-full flex items-center justify-center mb-4 mx-auto md:mx-0">
                                    <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                </div>
                                <h2 className="text-3xl font-extrabold tracking-tight italic">READY TO GO VIRAL! 🚀</h2>
                                <p className="text-slate-400 leading-relaxed">
                                    We've cropped your favorite moments and added professional cinematic captions. Use this to boost your social proof.
                                </p>
                            </div>

                            <div className="space-y-3">
                                <a
                                    href={reelUrl || '#'}
                                    download="viral-reel.mp4"
                                    className="w-full py-4 rounded-2xl bg-white text-black font-bold flex items-center justify-center gap-2 hover:bg-slate-200 transition-colors shadow-lg"
                                >
                                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                    </svg>
                                    Download Reel
                                </a>
                                <button
                                    onClick={() => router.push('/')}
                                    className="w-full py-4 rounded-2xl bg-white/5 border border-white/10 font-bold hover:bg-white/10 transition-colors shadow-lg"
                                >
                                    Start New Interview
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* ── STAGE: ERROR ── */}
                {stage === 'error' && (
                    <motion.div
                        key="error"
                        variants={containerVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="max-w-md w-full text-center space-y-8 z-10"
                    >
                        <div className="w-20 h-20 bg-red-500/10 border-2 border-red-500/30 rounded-3xl flex items-center justify-center mx-auto rotate-12">
                            <svg className="w-10 h-10 text-red-400 -rotate-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                        </div>

                        <div className="space-y-3">
                            <h2 className="text-2xl font-bold">Oops! Something went wrong</h2>
                            <p className="text-slate-400 text-sm">
                                {error || "We couldn't process your reel. Take a deep breath and try again."}
                            </p>
                        </div>

                        <div className="flex flex-col gap-3">
                            <button
                                onClick={generateViralReel}
                                className="w-full py-4 rounded-2xl bg-white text-black font-bold hover:bg-slate-200 transition-colors"
                            >
                                Try Again
                            </button>
                            <button
                                onClick={() => setStage('preview')}
                                className="w-full py-4 text-slate-500 hover:text-white transition-colors"
                            >
                                Back to Preview
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </main>
    );
}
