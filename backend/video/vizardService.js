const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

/**
 * Vizard.ai Integration Service
 * 
 * Flow:
 * 1. Upload local file to tmpfiles.org to get a public direct URL.
 * 2. Send the URL to Vizard.ai to create an AI clipping project.
 * 3. Poll Vizard.ai for the final high-quality viral reel.
 */

const VIZARDAI_BASE = 'https://elb-api.vizard.ai/hvizard-server-front/open-api/v1';
const VIZARDAI_API_KEY = process.env.VIZARD_API_KEY;

const { execSync, exec } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

/**
 * Step 1: Bridge local file to a public URL for Vizard ingestion
 */
async function getPublicUrl(filePath) {
    let finalPath = filePath;

    // Multer files often have no extension. tmpfiles.org requires one.
    // Also Vizard prefers .mp4.
    const hasExtension = filePath.includes('.');
    const isWebm = filePath.toLowerCase().endsWith('.webm');

    if (isWebm || !hasExtension) {
        const mp4Path = hasExtension ? filePath.replace(/\.[^/.]+$/, "") + ".mp4" : filePath + ".mp4";
        console.log(`[BRIDGE] Converting/Renaming to .mp4 for compatibility (Async)...`);
        try {
            // Use async exec to avoid blocking the event loop
            await new Promise((resolve, reject) => {
                exec(`"${ffmpegPath}" -i "${filePath}" -c:v libx264 -preset fast -crf 22 -c:a aac "${mp4Path}" -y`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            finalPath = mp4Path;
        } catch (err) {
            console.warn("[BRIDGE] FFmpeg failed, attempting simple rename as fallback.", err.message);
            try {
                fs.copyFileSync(filePath, mp4Path);
                finalPath = mp4Path;
            } catch (copyErr) {
                console.error("[BRIDGE] Fallback rename failed:", copyErr.message);
            }
        }
    }

    console.log(`[BRIDGE] Hosting file: ${finalPath}`);
    const stats = fs.statSync(finalPath);
    const formData = new FormData();
    // Providing knownLength is CRITICAL for some APIs when streaming
    formData.append('file', fs.createReadStream(finalPath), {
        filename: path.basename(finalPath),
        contentType: 'video/mp4',
        knownLength: stats.size
    });

    try {
        console.log(`[BRIDGE] Attempting primary host (tmpfiles.org) via CURL (Async)...`);
        const cmd = `curl -s -F "file=@${finalPath}" https://tmpfiles.org/api/v1/upload`;

        const resRaw = await new Promise((resolve, reject) => {
            exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const response = JSON.parse(resRaw);

        if (response.status === 'success') {
            const landingUrl = response.data.url;
            const directUrl = landingUrl.replace('http://', 'https://').replace('tmpfiles.org/', 'tmpfiles.org/dl/');
            console.log(`[BRIDGE] Public URL obtained: ${directUrl}`);
            return directUrl;
        }
        throw new Error(response.message || "Unknown error from tmpfiles.org");

    } catch (error) {
        console.warn(`[BRIDGE] Primary host failed: ${error.message}. Trying secondary (file.io) via CURL (Async)...`);

        try {
            const cmd = `curl -s -F "file=@${finalPath}" https://file.io`;
            const resRaw = await new Promise((resolve, reject) => {
                exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout);
                });
            });

            const response = JSON.parse(resRaw);

            if (response.success) {
                console.log(`[BRIDGE] Fallback URL obtained: ${response.link}`);
                return response.link;
            }
            throw new Error("Secondary bridge failed.");
        } catch (fbError) {
            console.error("[BRIDGE] All hosting attempts failed.");
            throw new Error("Hosting failed. Native CURL attempts to cloud bridges (tmpfiles, file.io) were blocked or timed out.");
        }
    }
}

/**
 * Step 2: Create Vizard Project
 */
async function uploadToVizard(filePath) {
    const publicUrl = await getPublicUrl(filePath);

    console.log(`[VIZARD] Creating project with URL: ${publicUrl}`);

    const payload = {
        videoUrl: publicUrl,
        videoType: 1, // Remote file
        ext: 'mp4', // Forced to mp4 after conversion
        lang: 'en',
        projectName: `Infera Reel ${Date.now()}`,
        ratioOfClip: 1, // 9:16 Vertical
        subtitleSwitch: 1,
        headlineSwitch: 1,
        removeSilenceSwitch: 1,
        autoBrollSwitch: 1
    };

    console.log(`[VIZARD] Using API Key: ${VIZARDAI_API_KEY ? VIZARDAI_API_KEY.substring(0, 4) + '...' + VIZARDAI_API_KEY.substring(VIZARDAI_API_KEY.length - 4) : 'MISSING'}`);

    try {
        const response = await axios.post(`${VIZARDAI_BASE}/project/create`, payload, {
            headers: {
                'Content-Type': 'application/json',
                'VIZARDAI_API_KEY': VIZARDAI_API_KEY
            }
        });

        const success = response.data.code === 200 || response.data.code === 2000 || response.data.projectId;

        if (!success) {
            console.error("[VIZARD] API Error Response:", JSON.stringify(response.data, null, 2));
            throw new Error(`Vizard API Error: ${response.data.message || response.data.msg || 'Unknown'}`);
        }

        const projectId = response.data.projectId || (response.data.data && response.data.data.projectId);
        console.log(`[VIZARD] Project Created! ID: ${projectId}`);
        return { projectId };
    } catch (error) {
        console.error("[VIZARD] Request failed:", error.response?.data || error.message);
        throw error;
    }
}

/**
 * Step 3: Poll for results
 */
async function pollForResults(projectId) {
    console.log(`[VIZARD] Polling for clips (this may take 1-3 minutes)...`);

    return new Promise((resolve, reject) => {
        let attempts = 0;
        const interval = setInterval(async () => {
            attempts++;
            try {
                const response = await axios.get(`${VIZARDAI_BASE}/project/query/${projectId}`, {
                    headers: { 'VIZARDAI_API_KEY': VIZARDAI_API_KEY }
                });

                const code = response.data.code;
                // Vizard sometimes nests data, sometimes puts it in the root
                const result = response.data;
                const data = result.data || result;

                console.log(`[VIZARD] Polling Response - Code: ${code}, Msg: ${result.message || result.msg}`);

                if (code === 2000) {
                    // Success!
                    clearInterval(interval);
                    const clips = data.videos || data.clips || [];
                    console.log(`[VIZARD] AI Finished! Found ${clips.length} viral clips.`);

                    if (clips.length > 0) {
                        const topClip = clips[0];
                        resolve({
                            videoUrl: topClip.videoUrl,
                            title: topClip.title || topClip.headline,
                            viralScore: topClip.viralScore
                        });
                    } else {
                        reject(new Error("Vizard processed the video but found no viral clips."));
                    }
                } else if (code === 1000) {
                    // Still processing, do nothing and let it loop
                    console.log(`[VIZARD] Video is still being clipped...`);
                } else if (code >= 4000) {
                    // Error state
                    clearInterval(interval);
                    console.error("[VIZARD] AI Processing failed:", JSON.stringify(response.data, null, 2));
                    reject(new Error(`Vizard AI Error: ${response.data.message || response.data.msg}`));
                } else if (attempts > 60) {
                    clearInterval(interval);
                    reject(new Error("Polling timed out. Please check your Vizard dashboard."));
                }
            } catch (error) {
                console.warn("[VIZARD] Request error (retrying...):", error.message);
            }
        }, 30000); // 30s as recommended in docs
    });
}

async function generateMockReel(localInputPath) {
    console.log("[VIZARD] MOCK MODE: Check your .env key!");
    return null;
}

module.exports = { uploadToVizard, pollForResults, generateMockReel };
