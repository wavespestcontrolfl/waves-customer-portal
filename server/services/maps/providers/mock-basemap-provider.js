const MOCK_CAPABILITIES = {
  canDisplayLive: false,
  canStoreStaticImage: false,
  canUseInPdf: false,
  canUseInSmsPreview: false,
  canDerivePersistentGeometry: false,
  maxCacheDays: 0,
  requiresAttribution: false,
};

function createMockBasemapProvider() {
  return {
    key: 'mock',
    capabilities: MOCK_CAPABILITIES,
    async getLiveMapConfig() {
      return null;
    },
  };
}

module.exports = {
  MOCK_CAPABILITIES,
  createMockBasemapProvider,
};
