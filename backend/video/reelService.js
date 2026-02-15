const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const path = require('path');
const fs = require('fs');
const { generateResponse } = require('../llm/llmService');

/**
 * Analyzes the transcript to find the best 10-15 second window for a reel.
 */
async function analyzeHighlights(transcript) {
    console.log("[REEL] Analyzing transcript for highlights...");
    const prompt = [
        {
            role: "system",
            content: "You are a viral video editor. Analyze the transcript of a testimonial interview and pick the most engaging 10-15 second continuous segment. Respond ONLY with a JSON object: { \"startTime\": number, \"endTime\": number, \"hookText\": \"string\" }. The hookText should be a catchy title."
        },
        {
            role: "user",
            content: `Transcript:\n${transcript}`
        }
    ];

    try {
        // Try Primary Key
        let response = await generateResponse({ messages: prompt });
        const analysis = JSON.parse(response);
        console.log(`[REEL] AI selected highlight: ${analysis.startTime}s - ${analysis.endTime}s: "${analysis.hookText}"`);
        return analysis;
    } catch (e) {
        console.warn("[REEL] Primary API Key failed, trying secondary...", e.message);
        try {
            // Manual swap for secondary key if possible
            const originalKey = process.env.GROQ_API_KEY;
            process.env.GROQ_API_KEY = process.env.GROQ_SECONDARY_API_KEY || originalKey;
            const response = await generateResponse({ messages: prompt });
            process.env.GROQ_API_KEY = originalKey; // Restore
            const analysis = JSON.parse(response);
            console.log(`[REEL] AI selected highlight (secondary): ${analysis.startTime}s - ${analysis.endTime}s: "${analysis.hookText}"`);
            return analysis;
        } catch (secondaryErr) {
            console.error("[REEL] All AI analysis failed, using default window", secondaryErr.message);
            return { startTime: 0, endTime: 15, hookText: "Amazing Experience!" };
        }
    }
}

/**
 * Generates a cinematic vertical reel from a full-screen recording.
 * Crops the user side, adds zoom, and exports 9:16.
 */
async function createReel(inputPath, outputPath, highlights) {
    return new Promise((resolve, reject) => {
        console.log(`[FFMPEG] Starting processing: ${inputPath} -> ${outputPath}`);

        const { startTime, endTime } = highlights;
        const duration = endTime - startTime;

        // DYNAMIC CROP:
        // Assume user is on the right side.
        // Height = ih (input height)
        // Width = ih * (9/16)
        // X = iw (input width) - (ih * 9/16)
        const dynamicCrop = "crop=w='ih*9/16':h='ih':x='iw-(ih*9/16)':y=0";

        ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(duration)
            .videoFilters([
                dynamicCrop,
                // 2. Scale to standard vertical HD
                'scale=1080:1920',
                // 3. Dynamic Zoom (Ken Burns)
                // z: zoom factor (1.0 to 1.3)
                // x,y: centering the zoom
                "zoompan=z='min(zoom+0.0015,1.3)':d=250:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920"
            ])
            .outputOptions([
                '-c:v libx264',
                '-preset fast',
                '-crf 22',
                '-c:a aac',
                '-b:a 192k',
                '-movflags +faststart'
            ])
            .on('start', (cmd) => console.log(`[FFMPEG] Command: ${cmd}`))
            .on('progress', (p) => {
                if (p.percent) console.log(`[FFMPEG] Progress: ${p.percent.toFixed(1)}%`);
            })
            .on('error', (err) => {
                console.error(`[FFMPEG] Error: ${err.message}`);
                reject(err);
            })
            .on('end', () => {
                console.log(`[FFMPEG] Finished! Saved to ${outputPath}`);
                resolve(outputPath);
            })
            .save(outputPath);
    });
}

module.exports = { analyzeHighlights, createReel };
