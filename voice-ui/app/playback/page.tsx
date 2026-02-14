"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function PlaybackPage() {
    const router = useRouter();
    const [videoUrl, setVideoUrl] = useState<string | null>(null);

    useEffect(() => {
        const url = sessionStorage.getItem('testimonial_video_url');
        if (url) {
            setVideoUrl(url);
        }
    }, []);

    return (
        <main className="min-h-screen w-full bg-[#0a0a0b] text-white flex items-center justify-center">
            <div className="max-w-lg w-full px-6 text-center">
                {/* Success Icon */}
                <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                    <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                </div>

                <h1 className="text-2xl font-bold mb-2">Testimonial Recorded!</h1>
                <p className="text-slate-400 mb-8">
                    Your video testimonial has been captured successfully.
                </p>

                {/* Video Preview */}
                {videoUrl && (
                    <div className="rounded-2xl overflow-hidden border border-white/10 mb-8">
                        <video
                            src={videoUrl}
                            controls
                            className="w-full"
                            style={{ maxHeight: '300px' }}
                        />
                    </div>
                )}

                {!videoUrl && (
                    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 mb-8">
                        <p className="text-slate-500 text-sm">No recording found. The video may not have been saved.</p>
                    </div>
                )}

                {videoUrl && (
                    <a
                        href={videoUrl}
                        download={`testimonial-${Date.now()}.webm`}
                        className="block w-full mb-3 px-8 py-3 rounded-xl font-semibold text-sm transition-all duration-300 cursor-pointer
                        bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 hover:border-emerald-500/50
                        text-emerald-400 hover:text-emerald-300 flex items-center justify-center gap-2"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download Video
                    </a>
                )}

                <button
                    onClick={() => {
                        sessionStorage.removeItem('testimonial_prompt');
                        sessionStorage.removeItem('testimonial_video_url');
                        router.push('/');
                    }}
                    className="w-full px-8 py-3 rounded-xl font-semibold text-sm transition-all duration-300 cursor-pointer
            bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500
            shadow-lg shadow-violet-600/20 hover:shadow-violet-500/30"
                >
                    Record Another Testimonial
                </button>
            </div>
        </main>
    );
}
