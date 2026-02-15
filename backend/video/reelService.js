const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const path = require('path');
const fs = require('fs');
const { generateResponse } = require('../llm/llmService');

/**
 * Analyzes the transcript to find the best window.
 * Now updated to be more flexible for longer segments.
 */
async function analyzeHighlights(transcript) {
    console.log("[REEL] Analyzing transcript for branded minimalistic reel...");

    // Proactive mapping for AI clarity
    const mappedTranscript = transcript
        .replace(/assistant:/gi, "AI INTERVIEWER:")
        .replace(/user:/gi, "USER:");

    const prompt = [
        {
            role: "system",
            content: `You are a professional social media video editor. 
            Analyze the transcript which contains a conversation between an AI INTERVIEWER and a USER.
            1. FULL DIALOGUE: You MUST generate captions for EVERY single word spoken in the transcript, including the AI's questions and the User's answers.
            2. SEAMLESS FLOW: The captions should provide a continuous reading experience of the entire video.
            3. SHORT & PUNCHY: Keep individual captions short (max 3 words).
            4. LOWERCASE: All captions MUST be in lowercase.
            Respond ONLY with a JSON object: 
            { 
              "startTime": 0, 
              "endTime": 0, 
              "hookText": "string",
              "captions": [
                { "text": "lowercase text", "start": number, "end": number }
              ]
            }`
        },
        {
            role: "user",
            content: `Transcript:\n${mappedTranscript}`
        }
    ];

    try {
        let response = await generateResponse({ messages: prompt });
        const analysis = JSON.parse(response);
        return analysis;
    } catch (e) {
        console.warn("[REEL] AI analysis failed, generating procedural fallback captions...");

        // PROCEDURAL FALLBACK: 
        // If AI fails, we still want captions. 
        // We'll split the transcript and distribute words/phrases over the 60s window (or total duration).
        // This ensures the "permanent tiktok based captioning" requirement is met.
        const words = mappedTranscript.replace(/AI INTERVIEWER:|USER:/gi, "").split(/\s+/).filter(w => w.length > 0);
        const fallbackCaptions = [];
        const wordsPerGroup = 3;

        for (let i = 0; i < words.length; i += wordsPerGroup) {
            const group = words.slice(i, i + wordsPerGroup).join(" ").toLowerCase();
            // Estimate timing based on roughly 150 words per minute
            const startStr = (i / words.length) * 55; // 55s buffer
            const endStr = startStr + 2;
            fallbackCaptions.push({
                text: group,
                start: parseFloat(startStr.toFixed(2)),
                end: parseFloat(endStr.toFixed(2))
            });
        }

        return {
            startTime: 0,
            endTime: 0,
            hookText: "UNBELIEVABLE MOMENT",
            captions: fallbackCaptions
        };
    }
}

/**
 * Generates a minimalistic vertical reel with branded TikTok captions.
 */
async function createReel(inputPath, outputPath, highlights) {
    return new Promise((resolve, reject) => {
        console.log(`[FFMPEG] Starting Branded TikTok Processing: ${inputPath}`);

        const { startTime, endTime, captions, hookText } = highlights;

        ffmpeg.ffprobe(inputPath, (err, data) => {
            if (err) {
                console.error("[FFMPEG] ffprobe error:", err);
                return reject(err);
            }

            const totalDuration = parseFloat(data.format.duration) || 15;
            const actualStart = parseFloat(startTime) || 0;
            const actualEnd = (parseFloat(endTime) > 0) ? parseFloat(endTime) : totalDuration;
            const duration = Math.max(1, actualEnd - actualStart);

            console.log(`[FFMPEG] Calculated Duration: ${duration}s (Start: ${actualStart}, End: ${actualEnd})`);

            const userCrop = "crop=w='ih*9/16':h='ih':x='iw/2 + (iw/2 - ih*9/16)/2':y=0";

            // 1. DYNAMIC CAPTIONS (Lowercase, outline, bottom-centered)
            const captionFilters = (captions || []).map(cap => {
                const text = cap.text.toLowerCase().replace(/'/g, "\\'").replace(/:/g, "\\:");
                return `drawtext=text='${text}':fontcolor=white:fontsize=100:fontfile=/System/Library/Fonts/Supplemental/Impact.ttf:x=(w-text_w)/2:y=h*0.75:enable='between(t,${cap.start},${cap.end})':bordercolor=black@0.8:borderw=4:shadowcolor=black@0.4:shadowx=2:shadowy=2`;
            });

            // 2. HOOK TITLE (White box background, black text, upper-middle)
            // Stays for the first 5 seconds.
            const hookFilter = hookText ?
                `drawtext=text='${hookText.toUpperCase()}':fontcolor=black:fontsize=90:fontfile=/System/Library/Fonts/Supplemental/Impact.ttf:x=(w-text_w)/2:y=h*0.35:box=1:boxcolor=white@1:boxborderw=25:enable='between(t,0,5)'`
                : null;

            // Subtle Watermark
            const watermarkFilter = `drawtext=text='Vizard.ai':fontcolor=white@0.5:fontsize=55:fontfile=/System/Library/Fonts/Supplemental/Impact.ttf:x=w-text_w-60:y=60`;

            // Fades
            const fadeInFilter = `fade=in:st=0:d=1.5`;
            const fadeOutFilter = `fade=out:st=${Math.max(0, duration - 1.5)}:d=1.5`;

            ffmpeg(inputPath)
                .setStartTime(actualStart)
                .setDuration(duration)
                .videoFilters([
                    'fps=30',
                    userCrop,
                    'scale=1080:1920',

                    // Subtle minimalistic movement
                    "zoompan=z='zoom+0.0003':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920",

                    // Natural contrast Polish
                    "unsharp=3:3:0.6:3:3:0.0",
                    "eq=brightness=0.03:saturation=1.4:contrast=1.1",

                    watermarkFilter,
                    ...(hookFilter ? [hookFilter] : []),
                    ...captionFilters,
                    fadeInFilter,
                    fadeOutFilter
                ])
                .outputOptions([
                    '-c:v libx264',
                    '-preset medium',
                    '-crf 20',
                    '-c:a aac',
                    '-b:a 192k',
                    '-movflags +faststart'
                ])
                .on('start', (cmd) => console.log(`[FFMPEG TIKTOK] Running: ${cmd}`))
                .on('progress', (p) => {
                    if (p.percent) console.log(`[FFMPEG] Progress: ${p.percent.toFixed(1)}%`);
                })
                .on('error', (err) => {
                    console.error("[FFMPEG] Error during encode:", err.message);
                    reject(err);
                })
                .on('end', () => {
                    console.log(`[FFMPEG] TikTok Branded Success! Saved to ${outputPath}`);
                    resolve(outputPath);
                })
                .save(outputPath);
        });
    });
}

module.exports = { analyzeHighlights, createReel };
