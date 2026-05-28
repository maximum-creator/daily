// Collect chapter quality data from page text + intercepted API responses
const { collectQuality } = require("../../lib/collector");

// Re-export the battle-tested implementation from lib/collector.js
// This avoids duplicating the complex API interception + text parsing logic
module.exports = { collectQuality };
