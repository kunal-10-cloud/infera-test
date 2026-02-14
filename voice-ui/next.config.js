/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  turbopack: {
    // Absolute path to this app so module resolution stays in voice-ui (fixes wrong workspace root when parent has lockfile)
    root: path.join(__dirname),
  },
};

module.exports = nextConfig;
