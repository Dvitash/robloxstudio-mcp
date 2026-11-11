const { createHash } = require('node:crypto');
const { join } = require('node:path');

// Synthetic peers must never inspect the developer's live Studio registry or
// mark the developer's Studios active.
const suite = createHash('sha256').update(expect.getState().testPath).digest('hex');
process.env.ROBLOXSTUDIO_MCP_MANAGED_INSTANCE_REGISTRY_DIR = join(
  process.env.RSMCP_JEST_REGISTRY_ROOT, suite,
);
// Nor may they list or close the developer's live Studio test windows.
process.env.ROBLOX_STUDIO_TEST_WINDOW_CLEANUP = 'off';
process.env.ROBLOXSTUDIO_MCP_ACTIVITY_DIR = join(
  process.env.RSMCP_JEST_REGISTRY_ROOT, 'activity', suite,
);
