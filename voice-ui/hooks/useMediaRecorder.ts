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
    const streamsRef = useRef<MediaStream[]>([]); // Keep track to stop all

    const startRecording = useCallback(async () => {
        try {
            // 1. Get Webcam Audio/Video for the UI Preview & AI
            const webcamStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 1280, height: 720, facingMode: "user" },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            streamsRef.current.push(webcamStream);

            // Set video preview to WEBCAM (so user sees themselves)
            if (videoRef.current) {
                videoRef.current.srcObject = webcamStream;
                videoRef.current.muted = true; // Local preview muted
                await videoRef.current.play();
            }

            // 2. Get Screen Stream for the RECORDING (System Audio + Screen Video)
            // Note: User MUST select "Share system audio"
            const screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: 1920,
                    height: 1080,
                    frameRate: 30
                },
                audio: true // Important: Captures system audio (AI voice)
            });
            streamsRef.current.push(screenStream);

            // 3. Mix Audio (Microphone + System Audio)
            const audioContext = new AudioContext();
            const dest = audioContext.createMediaStreamDestination();

            // Mic Source
            if (webcamStream.getAudioTracks().length > 0) {
                const micSource = audioContext.createMediaStreamSource(webcamStream);
                micSource.connect(dest);
            }

            // System Audio Source
            if (screenStream.getAudioTracks().length > 0) {
                const sysSource = audioContext.createMediaStreamSource(screenStream);
                sysSource.connect(dest);
            }

            // 4. Create Final Stream: Screen Video + Mixed Audio
            const mixedAudioTracks = dest.stream.getAudioTracks();
            const screenVideoTracks = screenStream.getVideoTracks();

            if (screenVideoTracks.length === 0) {
                throw new Error("No video track found in screen stream");
            }

            const finalStream = new MediaStream([
                screenVideoTracks[0],
                ...mixedAudioTracks
            ]);

            setStream(finalStream);

            // 5. Create Recorder
            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
                ? 'video/webm;codecs=vp9,opus'
                : 'video/webm';

            const recorder = new MediaRecorder(finalStream, { mimeType });
            chunksRef.current = [];

            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                }
            };

            recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: mimeType });
                console.log(`[RECORDER] Recording stopped. Blob size: ${blob.size} bytes`);
                const blobUrl = URL.createObjectURL(blob);
                sessionStorage.setItem('testimonial_video_url', blobUrl);

                if (resolveStopRef.current) {
                    resolveStopRef.current(blob);
                    resolveStopRef.current = null;
                }

                // Cleanup context
                audioContext.close();
            };

            // Handle user clicking "Stop Sharing" native browser button
            screenVideoTracks[0].onended = () => {
                console.log("[RECORDER] User stopped sharing screen");
                stopRecording();
            };

            mediaRecorderRef.current = recorder;
            recorder.start(1000);
            setIsRecording(true);
            console.log("[RECORDER] Full session recording started");

        } catch (err) {
            console.error("[RECORDER] Failed to start recording:", err);
            // Cleanup on error
            stopRecording();
        }
    }, []);

    const stopRecording = useCallback(async (): Promise<Blob | null> => {
        return new Promise((resolve) => {
            // If already stopped
            if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
                // Check if we have chunks anyway
                if (chunksRef.current.length > 0) {
                    const blob = new Blob(chunksRef.current, { type: 'video/webm' });
                    resolve(blob);
                } else {
                    resolve(null);
                }
            } else {
                resolveStopRef.current = resolve;
                mediaRecorderRef.current.stop();
            }

            // Stop logic continues in onstop event above...
            // But we must stop tracks here to allow restart
            streamsRef.current.forEach(s => s.getTracks().forEach(t => t.stop()));
            streamsRef.current = [];

            mediaRecorderRef.current = null;
            setIsRecording(false);
            setStream(null);
        });
    }, []);

    return { videoRef, isRecording, startRecording, stopRecording, stream };
}
