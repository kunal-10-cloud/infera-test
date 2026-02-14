"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleStart = () => {
    if (!prompt.trim()) return;
    setIsLoading(true);

    // Store the business prompt for Page 2 to pick up
    sessionStorage.setItem('testimonial_prompt', prompt.trim());

    router.push('/interview');
  };

  return (
    <main className="min-h-screen w-full bg-[#0a0a0b] text-white flex items-center justify-center relative overflow-hidden">
      {/* Background gradient effect */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-gradient-to-br from-violet-600/20 via-blue-600/10 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-gradient-to-tr from-emerald-600/10 to-transparent rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-2xl w-full px-6">
        {/* Logo / Brand */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <div className="inline-flex items-center gap-2 bg-white/5 px-4 py-1.5 rounded-full border border-white/10 mb-8">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] uppercase font-bold tracking-[0.2em] text-slate-400">AI-Powered</span>
          </div>

          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4 bg-gradient-to-r from-white via-white to-slate-400 bg-clip-text text-transparent">
            Collect Video Testimonials
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed max-w-md mx-auto">
            Let AI conduct a natural interview with your customers and capture authentic video testimonials in minutes.
          </p>
        </motion.div>

        {/* Prompt Input */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="space-y-6"
        >
          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the testimonial you want to collect...&#10;&#10;Example: Collect a testimonial for my pizza restaurant"
              className="w-full h-36 bg-white/[0.04] border border-white/10 rounded-2xl px-5 py-4 text-white text-base leading-relaxed placeholder:text-slate-500 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 resize-none transition-all duration-300"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.metaKey) handleStart();
              }}
            />
            <div className="absolute bottom-3 right-3 text-[10px] text-slate-600 font-mono">
              ⌘ + Enter
            </div>
          </div>

          <button
            onClick={handleStart}
            disabled={!prompt.trim() || isLoading}
            className="w-full py-4 rounded-2xl font-semibold text-base transition-all duration-300 cursor-pointer disabled:cursor-not-allowed
              bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500
              disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500
              shadow-lg shadow-violet-600/20 hover:shadow-violet-500/30 disabled:shadow-none"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Preparing Interview...
              </span>
            ) : (
              "Start Video Testimonial →"
            )}
          </button>

          <p className="text-center text-xs text-slate-600">
            The AI will conduct a 2-minute conversational interview
          </p>
        </motion.div>
      </div>
    </main>
  );
}
