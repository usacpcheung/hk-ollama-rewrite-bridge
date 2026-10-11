// Preserve historical validation order for unregistered T2A selections only.
const { minimaxT2APolicy } = require('../providers/minimax-t2a-compatibility');
module.exports = { unsupportedT2APolicy: { ...minimaxT2APolicy, supportsVoiceChoice: () => false } };
