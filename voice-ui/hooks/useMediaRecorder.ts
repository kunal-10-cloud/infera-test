"use client";

import { useState, useRef, useCallback } from 'react';

interface UseMediaRecorderReturn {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    isRecording: boolean;
    startRecording: () => Promise<void>;
    stopRecording: () => Promise<Blob | null>;
    stream: MediaStream | null;
}

export function useMediaRecorder(): UseMediaRecorderReturn {
    const [isRecording, setIsRecording] = useState(false);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const resolveStopRef = useRef<((blob: Blob | null) => void) | null>(null);

    const startRecording = useCallback(async () => {
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 1280, height: 720, facingMode: "user" },
                audio: true
            });

            setStream(mediaStream);

            // Set video preview
            if (videoRef.current) {
                videoRef.current.srcObject = mediaStream;
                videoRef.current.muted = true; // Prevent echo
                await videoRef.current.play();
            }

            // Create MediaRecorder
            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
                ? 'video/webm;codecs=vp9,opus'
                : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
                    ? 'video/webm;codecs=vp8,opus'
                    : 'video/webm';

            const recorder = new MediaRecorder(mediaStream, { mimeType });
            chunksRef.current = [];

            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                }
            };

            recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: mimeType });
                console.log(`[RECORDER] Recording stopped. Blob size: ${blob.size} bytes`);

                // Store blob in sessionStorage as a URL for playback page
                const blobUrl = URL.createObjectURL(blob);
                sessionStorage.setItem('testimonial_video_url', blobUrl);

                if (resolveStopRef.current) {
                    resolveStopRef.current(blob);
                    resolveStopRef.current = null;
                }
            };

            mediaRecorderRef.current = recorder;
            recorder.start(1000); // Collect data every 1 second
            setIsRecording(true);
            console.log("[RECORDER] Recording started");

        } catch (err) {
            console.error("[RECORDER] Failed to start recording:", err);
        }
    }, []);

    const stopRecording = useCallback(async (): Promise<Blob | null> => {
        return new Promise((resolve) => {
            if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
                resolve(null);
                return;
            }

            resolveStopRef.current = resolve;

            // Stop all tracks
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
            }

            mediaRecorderRef.current.stop();
            mediaRecorderRef.current = null;
            setIsRecording(false);
            setStream(null);
        });
    }, [stream]);

    return { videoRef, isRecording, startRecording, stopRecording, stream };
}
