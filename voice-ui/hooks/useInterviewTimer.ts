"use client";

import { useState, useEffect, useRef, useCallback } from 'react';

interface UseInterviewTimerOptions {
    durationSeconds: number;
    onExpire: () => void;
    autoStart?: boolean;
}

export function useInterviewTimer({ durationSeconds, onExpire, autoStart = false }: UseInterviewTimerOptions) {
    const [timeLeft, setTimeLeft] = useState(durationSeconds);
    const [isRunning, setIsRunning] = useState(false);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const onExpireRef = useRef(onExpire);
    const hasExpiredRef = useRef(false);

    // Keep callback ref fresh without re-triggering effects
    onExpireRef.current = onExpire;

    const start = useCallback(() => {
        if (isRunning) return;
        hasExpiredRef.current = false;
        setIsRunning(true);
    }, [isRunning]);

    const stop = useCallback(() => {
        setIsRunning(false);
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (autoStart) {
            start();
        }
    }, [autoStart, start]);

    useEffect(() => {
        if (!isRunning) return;

        intervalRef.current = setInterval(() => {
            setTimeLeft(prev => {
                const next = prev - 1;
                if (next <= 0 && !hasExpiredRef.current) {
                    hasExpiredRef.current = true;
                    // Call onExpire on next tick to avoid state update during render
                    setTimeout(() => onExpireRef.current(), 0);
                    return 0;
                }
                return next;
            });
        }, 1000);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [isRunning]);

    const formattedTime = `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`;
    const isExpired = timeLeft <= 0;

    return { timeLeft, formattedTime, isExpired, isRunning, start, stop };
}
