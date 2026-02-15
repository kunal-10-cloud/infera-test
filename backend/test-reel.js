const { analyzeHighlights, createReel } = require('./video/reelService');
const fs = require('fs');
const path = require('path');

async function test() {
    const inputPath = process.argv[2];
    if (!inputPath) {
        console.error("Please provide an input video path.");
        process.exit(1);
    }

    const transcript = "AI: Hello there! How was your experience with Infera today? User: Oh, it was absolutely amazing! I loved the speed and the quality of the results. AI: That's great to hear! Would you recommend it to others? User: Definitely, I'm already telling all my friends about it!";

    console.log("🚀 Starting manual reel test...");

    try {
        const highlights = await analyzeHighlights(transcript);
        const outputPath = path.join(__dirname, 'test-viral-reel.mp4');

        const windowText = highlights.endTime === 0 ? "Full Video" : `${highlights.startTime}s to ${highlights.endTime}s`;
        console.log(`🎬 Processing highlights: ${windowText}...`);

        await createReel(inputPath, outputPath, highlights);

        console.log(`✅ SUCCESS! Saved to: ${outputPath}`);
    } catch (err) {
        console.error("❌ FAILED:", err);
    }
}

test();
